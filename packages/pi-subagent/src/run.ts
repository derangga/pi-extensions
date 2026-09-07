import { Context, Deferred, Effect, Layer, Schema } from "effect";

import { loadAgentFile, type AgentFile } from "./agent-file.js";
import {
  formatGraphError,
  planGraph,
  runGraph,
  type GraphError,
  type PlannedTask,
  type RunTask,
  type Settlement,
  type TaskInput,
} from "./graph.js";
import {
  createIntercomTools,
  Intercom,
  type ParentTraffic,
  type ReplyOutcome,
  type TaskAddress,
} from "./intercom.js";
import {
  runChildLifecycle,
  type ChildFactory,
  type ChildOutcome,
  type ChildRunResult,
} from "./lifecycle.js";
import {
  formatResolveError,
  modelKey,
  resolveTasks,
  type ModelSource,
  type ParentChoice,
  type ResolveError,
  type TaskChoice,
} from "./resolve.js";
import { Settings } from "./settings.js";
import type { PiModel, ThinkingLevel } from "./thinking.js";

/** A task as the tool schema decodes it: the graph's fields plus the choices. */
export interface TaskRequest extends TaskInput {
  readonly agent: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly maxTurns?: number;
}

/** Everything a run needs from the calling session, gathered at tool time. */
export interface StartRequest {
  readonly tasks: readonly TaskRequest[];
  readonly cwd: string;
  readonly parent: ParentChoice;
  readonly parentSession: string | undefined;
  readonly source: ModelSource;
  /** Test seam. Production callers leave this undefined and get a real session. */
  readonly create?: ChildFactory;
}

export type TaskStatus = "pending" | "running" | "settled" | "skipped";

export interface TaskView {
  readonly id: string;
  readonly index: number;
  readonly wave: number;
  readonly agent: string;
  readonly task: string;
  readonly needs: readonly string[];
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly status: TaskStatus;
  readonly outcome: ChildOutcome | undefined;
  readonly output: string | undefined;
  readonly sessionFile: string | undefined;
  readonly turns: number;
  /** The needs that produced nothing. Non-empty means the task never ran. */
  readonly missing: readonly string[];
  readonly notes: readonly string[];
}

export interface RunView {
  readonly id: string;
  readonly startedAt: number;
  readonly finished: boolean;
  readonly cancelled: boolean;
  readonly tasks: readonly TaskView[];
}

/**
 * What a wait returns. Traffic comes back inside the same tool result rather
 * than making the parent stop waiting to hear that a child asked something.
 */
export type WaitOutcome =
  | { readonly kind: "settled"; readonly run: RunView }
  | {
      readonly kind: "traffic";
      readonly run: RunView;
      readonly messages: readonly ParentTraffic[];
    };

export class AgentFileUnreadable extends Schema.TaggedError<AgentFileUnreadable>()(
  "AgentFileUnreadable",
  { agent: Schema.String, message: Schema.String },
) {}

export class UnknownRun extends Schema.TaggedError<UnknownRun>()("UnknownRun", {
  runId: Schema.String,
  known: Schema.Array(Schema.String),
}) {}

export class UnknownTask extends Schema.TaggedError<UnknownTask>()("UnknownTask", {
  runId: Schema.String,
  taskId: Schema.String,
  known: Schema.Array(Schema.String),
}) {}

export type StartError = GraphError | ResolveError | AgentFileUnreadable;
export type ManagerError = StartError | UnknownRun | UnknownTask;

export function formatManagerError(error: ManagerError): string {
  switch (error._tag) {
    case "AgentFileUnreadable":
      return `Agent "${error.agent}": ${error.message}`;
    case "UnknownRun":
      return error.known.length === 0
        ? "No subagent run has been started in this session."
        : `No run "${error.runId}". Runs in this session: ${error.known.join(", ")}.`;
    case "UnknownTask":
      return `Run "${error.runId}" has no task "${error.taskId}". Its tasks are: ${error.known.join(", ")}.`;
    case "ModelNotFound":
    case "ThinkingUnsupported":
    case "NoModelAvailable":
      return formatResolveError(error);
    default:
      return formatGraphError(error);
  }
}

interface TaskState {
  readonly id: string;
  readonly index: number;
  readonly wave: number;
  readonly agent: string;
  readonly task: string;
  readonly needs: readonly string[];
  readonly systemPrompt: string;
  /** What the child session is built with. */
  readonly resolvedModel: PiModel;
  /** The same model as `provider/id`, which is what a reader wants to see. */
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly maxTurns: number;
  /** Completed once, when the task reaches a terminal status. */
  readonly settled: Deferred.Deferred<void>;
  status: TaskStatus;
  result: ChildRunResult | undefined;
  missing: readonly string[];
  notes: readonly string[];
}

interface RunState {
  readonly id: string;
  readonly startedAt: number;
  readonly tasks: readonly TaskState[];
  readonly byId: ReadonlyMap<string, TaskState>;
  /**
   * Cancellation aborts this rather than interrupting the run fiber. Children
   * then settle as `stopped` and every result already collected survives.
   */
  readonly controller: AbortController;
  readonly done: Deferred.Deferred<void>;
  cancelled: boolean;
  finished: boolean;
}

function viewTask(state: TaskState): TaskView {
  return {
    id: state.id,
    index: state.index,
    wave: state.wave,
    agent: state.agent,
    task: state.task,
    needs: state.needs,
    model: state.model,
    thinking: state.thinking,
    status: state.status,
    outcome: state.result?.outcome,
    output: state.result?.output,
    sessionFile: state.result?.sessionFile,
    turns: state.result?.turns ?? 0,
    missing: state.missing,
    notes: state.notes,
  };
}

function viewRun(run: RunState): RunView {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finished: run.finished,
    cancelled: run.cancelled,
    tasks: run.tasks.map(viewTask),
  };
}

/**
 * The child's system prompt. An agent file addressed by exact name supplies its
 * whole body; anything else is the role the orchestrator invented for this one
 * call, which is the point of having no catalog.
 */
function systemPromptFor(agent: string, file: AgentFile | undefined): string {
  if (file) return file.prompt;
  const described = agent.trim();
  return described ? `You are ${described}.` : "";
}

/** A task the run never reached. It costs no session and produces no output. */
function stoppedBeforeStart(): ChildRunResult {
  return {
    outcome: "stopped",
    output: "[Status: Stopped by the user before this task started.]",
    producedOutput: false,
    partial: true,
    turns: 0,
    sessionFile: undefined,
    notes: [],
  };
}

const readAgentFile = Effect.fn("Manager.agentFile")(function* (
  agent: string,
  cwd: string,
): Effect.fn.Return<AgentFile | undefined, AgentFileUnreadable> {
  return yield* Effect.try({
    try: () => loadAgentFile(agent, cwd),
    catch: (cause) =>
      new AgentFileUnreadable({
        agent,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

/**
 * The run registry. One instance per session, holding every run this session
 * started and the fibers driving them.
 */
export class Manager extends Context.Service<
  Manager,
  {
    start(request: StartRequest): Effect.Effect<RunView, StartError>;
    view(runId: string | undefined): Effect.Effect<RunView, UnknownRun>;
    wait(
      runId: string | undefined,
      taskId: string | undefined,
    ): Effect.Effect<WaitOutcome, UnknownRun | UnknownTask>;
    reply(
      runId: string | undefined,
      taskId: string,
      message: string,
    ): Effect.Effect<ReplyOutcome, UnknownRun | UnknownTask>;
    cancel(runId: string | undefined): Effect.Effect<RunView, UnknownRun>;
  }
>()("pi-subagent/Manager") {
  static readonly layer = Layer.effect(
    Manager,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const intercom = yield* Intercom;
      /**
       * Captured once so `start` can fork into it later without carrying Scope
       * in its own signature. Closing it interrupts every run in flight.
       */
      const scope = yield* Effect.scope;

      const runs = new Map<string, RunState>();
      const order: string[] = [];
      let counter = 0;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const run of runs.values()) run.controller.abort();
        }),
      );

      const lookup = Effect.fn("Manager.lookup")(function* (
        runId: string | undefined,
      ): Effect.fn.Return<RunState, UnknownRun> {
        // No id addresses the newest run, which is the one the orchestrator
        // just started and almost always means.
        const id = runId ?? order[order.length - 1];
        const run = id === undefined ? undefined : runs.get(id);
        if (!run) return yield* new UnknownRun({ runId: id ?? "", known: [...order] });
        return run;
      });

      const lookupTask = Effect.fn("Manager.lookupTask")(function* (
        run: RunState,
        taskId: string,
      ): Effect.fn.Return<TaskState, UnknownTask> {
        const task = run.byId.get(taskId);
        if (!task) {
          return yield* new UnknownTask({
            runId: run.id,
            taskId,
            known: run.tasks.map((state) => state.id),
          });
        }
        return task;
      });

      const settleTask = Effect.fn("Manager.settleTask")(function* (
        state: TaskState,
        result: ChildRunResult,
      ) {
        state.status = "settled";
        state.result = result;
        state.notes = [...state.notes, ...result.notes];
        yield* Deferred.succeed(state.settled, undefined);
      });

      const runOneTask = (run: RunState, request: StartRequest): RunTask =>
        Effect.fn("Manager.runTask")(function* (task: PlannedTask, prompt: string) {
          const state = run.byId.get(task.id);
          if (!state) return undefined;

          if (run.controller.signal.aborted) {
            yield* settleTask(state, stoppedBeforeStart());
            return undefined;
          }

          const address: TaskAddress = { runId: run.id, taskId: state.id, task: state.task };
          state.status = "running";

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const channel = yield* intercom.openTask(address);
              return yield* runChildLifecycle({
                child: {
                  cwd: request.cwd,
                  name: state.task,
                  prompt: state.systemPrompt,
                  model: state.resolvedModel,
                  thinking: state.thinking,
                  ...(request.parentSession ? { parentSession: request.parentSession } : {}),
                  customTools: createIntercomTools(channel),
                },
                task: prompt,
                maxTurns: state.maxTurns,
                signal: run.controller.signal,
                ...(request.create ? { create: request.create } : {}),
              });
            }),
          );

          yield* settleTask(state, result);
          yield* intercom.settle(address, result);
          // Only real output flows down an edge. A child that died without
          // saying anything leaves its dependents to skip rather than run
          // against a prompt with a hole in it.
          return result.producedOutput ? result.output : undefined;
        });

      const markSkipped = (run: RunState, settlements: readonly Settlement[]) =>
        Effect.forEach(
          settlements.filter((settlement) => run.byId.get(settlement.id)?.status === "pending"),
          Effect.fn("Manager.markSkipped")(function* (settlement: Settlement) {
            const state = run.byId.get(settlement.id)!;
            state.status = "skipped";
            state.missing = settlement.missing;
            yield* Deferred.succeed(state.settled, undefined);
          }),
          { discard: true },
        );

      const finish = Effect.fn("Manager.finish")(function* (run: RunState) {
        run.finished = true;
        // Defensive: an interrupted run leaves tasks that never settled, and a
        // parent blocked on one of them would wait for a fiber that is gone.
        yield* Effect.forEach(run.tasks, (state) => Deferred.succeed(state.settled, undefined), {
          discard: true,
        });
        yield* Deferred.succeed(run.done, undefined);
        yield* intercom.finishRun(run.id);
      });

      const execute = Effect.fn("Manager.execute")(
        function* (run: RunState, plan: readonly PlannedTask[], request: StartRequest) {
          const settlements = yield* runGraph(plan, runOneTask(run, request));
          yield* markSkipped(run, settlements);
        },
        Effect.provideService(Settings, settings),
      );

      const start = Effect.fn("Manager.start")(function* (
        request: StartRequest,
      ): Effect.fn.Return<RunView, StartError> {
        const plan = yield* planGraph(request.tasks);

        const files = yield* Effect.forEach(request.tasks, (task) =>
          readAgentFile(task.agent, request.cwd),
        );

        const choices: TaskChoice[] = plan.map((task) => {
          const request_ = request.tasks[task.index]!;
          const file = files[task.index];
          return {
            id: task.id,
            agent: request_.agent,
            ...(file ? { agentFile: file.choice } : {}),
            ...(request_.model ? { model: request_.model } : {}),
            ...(request_.thinking ? { thinking: request_.thinking } : {}),
          };
        });

        const resolved = yield* resolveTasks(request.source, request.parent, choices).pipe(
          Effect.provideService(Settings, settings),
        );
        const current = yield* settings.current;

        const states: TaskState[] = [];
        for (const task of plan) {
          const choice = resolved[task.index]!;
          const request_ = request.tasks[task.index]!;
          states.push({
            id: task.id,
            index: task.index,
            wave: task.wave,
            agent: request_.agent,
            task: task.task,
            needs: task.needs,
            systemPrompt: systemPromptFor(request_.agent, files[task.index]),
            resolvedModel: choice.model,
            model: modelKey(choice.model),
            thinking: choice.thinking,
            maxTurns: request_.maxTurns ?? current.maxTurns,
            settled: yield* Deferred.make<void>(),
            status: "pending",
            result: undefined,
            missing: [],
            notes: choice.notes,
          });
        }

        counter += 1;
        const run: RunState = {
          id: `run_${counter}`,
          startedAt: Date.now(),
          tasks: states,
          byId: new Map(states.map((state) => [state.id, state])),
          controller: new AbortController(),
          done: yield* Deferred.make<void>(),
          cancelled: false,
          finished: false,
        };
        runs.set(run.id, run);
        order.push(run.id);

        yield* Effect.forkIn(execute(run, plan, request).pipe(Effect.ensuring(finish(run))), scope);
        return viewRun(run);
      });

      const view = Effect.fn("Manager.view")(function* (runId: string | undefined) {
        return viewRun(yield* lookup(runId));
      });

      const wait = Effect.fn("Manager.wait")(function* (
        runId: string | undefined,
        taskId: string | undefined,
      ): Effect.fn.Return<WaitOutcome, UnknownRun | UnknownTask> {
        const run = yield* lookup(runId);
        const target = taskId === undefined ? undefined : yield* lookupTask(run, taskId);

        const done = () =>
          target ? target.status === "settled" || target.status === "skipped" : run.finished;

        /**
         * A task settling is not what this call is waiting for: its output
         * comes back in the run result either way. So a wake carrying only
         * settlements parks again, and only an ask or a notification cuts the
         * wait short. Traffic published during the gap between two parks
         * reaches the parent as an ordinary message instead, which is what the
         * unparked path already does.
         */
        while (!done()) {
          const collected = yield* Effect.scoped(
            Effect.gen(function* () {
              const waiter = yield* intercom.park(run.id);
              if (done()) return undefined;

              const settled = (
                target ? Deferred.await(target.settled) : Deferred.await(run.done)
              ).pipe(Effect.as(undefined));
              const traffic = waiter.wait;

              const first = yield* Effect.raceFirst(settled, traffic);
              return first?.filter((message) => message.kind !== "settled");
            }),
          );
          if (collected && collected.length > 0) {
            return {
              kind: "traffic",
              run: viewRun(run),
              messages: collected,
            } satisfies WaitOutcome;
          }
        }

        return { kind: "settled", run: viewRun(run) } satisfies WaitOutcome;
      });

      const reply = Effect.fn("Manager.reply")(function* (
        runId: string | undefined,
        taskId: string,
        message: string,
      ): Effect.fn.Return<ReplyOutcome, UnknownRun | UnknownTask> {
        const run = yield* lookup(runId);
        yield* lookupTask(run, taskId);
        return yield* intercom.reply(run.id, taskId, message);
      });

      const cancel = Effect.fn("Manager.cancel")(function* (runId: string | undefined) {
        const run = yield* lookup(runId);
        run.cancelled = true;
        run.controller.abort();
        return viewRun(run);
      });

      return Manager.of({ start, view, wait, reply, cancel });
    }),
  );
}
