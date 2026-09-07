import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MAX_TASKS } from "./graph.js";
import type { ParentTraffic } from "./intercom.js";
import type { ReplyOutcome } from "./intercom.js";
import type { RunView, TaskRequest, TaskView, WaitOutcome } from "./run.js";
import { MAX_TURNS, MIN_TURNS } from "./settings.js";
import { THINKING_LEVELS } from "./thinking.js";

/**
 * What the tools need from the run manager. Every method rejects with an Error
 * whose message is already formatted for the model, because that is what Pi
 * turns a thrown tool error into.
 */
export interface SubagentToolHost {
  start(tasks: readonly TaskRequest[], ctx: ExtensionContext): Promise<RunView>;
  wait(runId: string | undefined, taskId: string | undefined): Promise<WaitOutcome>;
  view(runId: string | undefined): Promise<RunView>;
  reply(runId: string | undefined, taskId: string, message: string): Promise<ReplyOutcome>;
  cancel(runId: string | undefined): Promise<RunView>;
}

const THINKING = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  { description: "Thinking effort for this task. A user setting outranks it." },
);

const TASK = Type.Object(
  {
    agent: Type.String({
      description:
        "The role this child plays, invented for this call, such as 'a dependency archaeologist'. A bare name that matches an agent file in .pi/agents loads that file instead.",
    }),
    task: Type.String({ description: "Three to five words naming the task, for status rows." }),
    prompt: Type.String({
      description:
        "The whole instruction for the child. It sees no parent conversation, so state the goal, the scope and the shape of the answer.",
    }),
    id: Type.Optional(
      Type.String({
        description:
          "Names this task so others can depend on it. Letters, digits, underscore and hyphen. Defaults to task_1, task_2 and so on.",
      }),
    ),
    needs: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Ids this task waits for. Their output is prepended to this prompt, so never restate it yourself. Write {previous} to place the first one inline.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Model for this task. A user setting outranks it." }),
    ),
    thinking: Type.Optional(THINKING),
    maxTurns: Type.Optional(
      Type.Integer({
        minimum: MIN_TURNS,
        maximum: MAX_TURNS,
        description: "Turn limit for this child. Defaults to the /subagent setting.",
      }),
    ),
  },
  { additionalProperties: false },
);

const SUBAGENT_PARAMS = Type.Object(
  {
    tasks: Type.Array(TASK, {
      minItems: 1,
      maxItems: MAX_TASKS,
      description: "Every sub-task of this piece of work, in one call.",
    }),
    autoAwait: Type.Optional(
      Type.Boolean({
        description:
          "Block until the run settles and return every result. Leave it off unless the next thing you do depends on the answers.",
      }),
    ),
  },
  { additionalProperties: false },
);

const RESULT_PARAMS = Type.Object(
  {
    runId: Type.Optional(Type.String({ description: "Defaults to the most recent run." })),
    taskId: Type.Optional(Type.String({ description: "One task instead of the whole run." })),
    wait: Type.Optional(
      Type.Boolean({ description: "Block until it settles, or until a child asks something." }),
    ),
    verbose: Type.Optional(
      Type.Boolean({ description: "Add model, thinking, turns and any degradation notes." }),
    ),
  },
  { additionalProperties: false },
);

const REPLY_PARAMS = Type.Object(
  {
    taskId: Type.String({ description: "The task that asked." }),
    message: Type.String({ description: "The answer. The child resumes with it." }),
    runId: Type.Optional(Type.String({ description: "Defaults to the most recent run." })),
  },
  { additionalProperties: false },
);

const CANCEL_PARAMS = Type.Object(
  { runId: Type.Optional(Type.String({ description: "Defaults to the most recent run." })) },
  { additionalProperties: false },
);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The wave line is omitted when nothing has edges, so flat work renders flat. */
function taskRow(task: TaskView, graph: boolean): string {
  const wave = graph ? `wave ${task.wave + 1}  ` : "";
  const needs = task.needs.length > 0 ? `  needs ${task.needs.join(", ")}` : "";
  return `  ${task.id}  ${wave}${task.task} (${task.agent})${needs}`;
}

export function formatStart(run: RunView): string {
  const graph = run.tasks.some((task) => task.needs.length > 0);
  const rows = run.tasks.map((task) => taskRow(task, graph)).join("\n");
  return [
    `Started ${run.id} with ${plural(run.tasks.length, "task")}.`,
    rows,
    "",
    "End your turn. Each task reports back as it settles, and subagent_result returns the whole run.",
  ].join("\n");
}

function statusOf(task: TaskView): string {
  switch (task.status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "skipped":
      return `skipped (${task.missing.join(", ")} produced nothing)`;
    case "settled":
      return task.outcome ?? "settled";
  }
}

function detailLines(task: TaskView, verbose: boolean): string[] {
  const lines: string[] = [];
  if (task.sessionFile) lines.push(`transcript: ${task.sessionFile}`);
  if (!verbose) return lines;
  lines.push(`model: ${task.model}  thinking: ${task.thinking}  turns: ${task.turns}`);
  for (const note of task.notes) lines.push(`note: ${note}`);
  return lines;
}

export interface ReportOptions {
  readonly taskId?: string | undefined;
  readonly verbose?: boolean | undefined;
}

export function formatRun(run: RunView, options: ReportOptions = {}): string {
  const tasks = options.taskId ? run.tasks.filter((task) => task.id === options.taskId) : run.tasks;
  const verbose = options.verbose === true;

  const blocks = tasks.map((task) => {
    const body = task.output?.trim();
    return [
      `## ${task.task} (${task.id}) — ${statusOf(task)}`,
      ...detailLines(task, verbose),
      "",
      body && body.length > 0 ? body : "(no output)",
    ].join("\n");
  });

  const settled = run.tasks.filter(
    (task) => task.status === "settled" || task.status === "skipped",
  ).length;
  const heading = run.finished
    ? `${run.id}${run.cancelled ? " (cancelled)" : ""}: all ${plural(run.tasks.length, "task")} settled.`
    : `${run.id}${run.cancelled ? " (cancelling)" : ""}: ${settled} of ${run.tasks.length} settled, still running.`;

  return [heading, "", ...blocks].join("\n\n");
}

/**
 * Traffic that arrived while the parent was blocked. A settled task is named
 * rather than quoted: its output is coming back in the run result, and printing
 * it twice in one conversation buys nothing.
 */
export function formatTrafficReport(run: RunView, messages: readonly ParentTraffic[]): string {
  const lines = messages.map((message) => {
    const { address } = message;
    switch (message.kind) {
      case "ask":
        return `[${address.task} (${address.taskId}) asks]\n${message.text}\n\nAnswer with reply_subagent, or call subagent_result again to keep waiting.`;
      case "notify":
        return `[${address.task} (${address.taskId}), ${message.level}]\n${message.text}`;
      case "settled":
        return `[${address.task} (${address.taskId}) ${message.outcome}]`;
    }
  });
  const pending = run.tasks.filter(
    (task) => task.status === "pending" || task.status === "running",
  ).length;
  return [`${run.id}: ${plural(pending, "task")} still running.`, "", ...lines].join("\n\n");
}

function reportWait(outcome: WaitOutcome, options: ReportOptions): string {
  return outcome.kind === "settled"
    ? formatRun(outcome.run, options)
    : formatTrafficReport(outcome.run, outcome.messages);
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

export function createSubagentTools(host: SubagentToolHost): ToolDefinition[] {
  return [
    {
      name: "subagent",
      label: "Subagent",
      description:
        "Delegate research to read-only child agents. Children can read, grep, find and list; they cannot edit, write or run commands. Pass every sub-task of the work in one call: tasks with no needs run in parallel, and a task with needs starts once those settle, with their output prepended to its prompt.",
      promptSnippet: "Delegate read-only research to child agents in one batched call.",
      promptGuidelines: [
        "Batch every sub-task of a piece of work into one subagent call rather than issuing several calls.",
        "Declare ordering with needs rather than by splitting the work across calls.",
        "Never restate an upstream result in a dependent's prompt; the edge already delivers it.",
        "A child sees none of this conversation, so write each prompt to stand alone.",
        "End your turn after starting a run. Do not idle waiting for it.",
      ],
      parameters: SUBAGENT_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { tasks, autoAwait } = params as {
          tasks: readonly TaskRequest[];
          autoAwait?: boolean;
        };
        const run = await host.start(tasks, ctx);
        if (autoAwait !== true) return text(formatStart(run));
        return text(reportWait(await host.wait(run.id, undefined), {}));
      },
    },
    {
      name: "subagent_result",
      label: "Subagent Result",
      description:
        "Read a subagent run: every task's output, or one task's. With wait it blocks until the run settles, and returns early if a child asks a question. Each task reports the session file its transcript is in.",
      promptSnippet: "Read the output of a subagent run.",
      parameters: RESULT_PARAMS,
      async execute(_toolCallId, params) {
        const { runId, taskId, wait, verbose } = params as {
          runId?: string;
          taskId?: string;
          wait?: boolean;
          verbose?: boolean;
        };
        const options: ReportOptions = { taskId, verbose };
        if (wait !== true) return text(formatRun(await host.view(runId), options));
        return text(reportWait(await host.wait(runId, taskId), options));
      },
    },
    {
      name: "reply_subagent",
      label: "Reply To Subagent",
      description:
        "Answer a question a child asked with ask_parent. The child resumes as soon as the answer lands.",
      promptSnippet: "Answer a subagent's question.",
      parameters: REPLY_PARAMS,
      async execute(_toolCallId, params) {
        const { runId, taskId, message } = params as {
          runId?: string;
          taskId: string;
          message: string;
        };
        const outcome = await host.reply(runId, taskId, message);
        return text(
          outcome === "delivered"
            ? `Delivered to ${taskId}.`
            : `${taskId} is not waiting for an answer. It either moved on or has already finished.`,
        );
      },
    },
    {
      name: "subagent_cancel",
      label: "Cancel Subagent",
      description:
        "Stop a run. Children in flight are aborted and report what they had, and tasks that never started are skipped.",
      promptSnippet: "Stop a subagent run.",
      parameters: CANCEL_PARAMS,
      async execute(_toolCallId, params) {
        const { runId } = params as { runId?: string };
        const run = await host.cancel(runId);
        const stopped = run.tasks.filter(
          (task) => task.status === "pending" || task.status === "running",
        ).length;
        return text(
          `Cancelled ${run.id}. ${plural(stopped, "task")} stopped; call subagent_result for what the run produced.`,
        );
      },
    },
  ];
}

export function registerSubagentTools(pi: ExtensionAPI, host: SubagentToolHost): void {
  for (const tool of createSubagentTools(host)) pi.registerTool(tool);
}
