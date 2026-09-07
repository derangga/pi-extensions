import { Effect, Option, Schema } from "effect";

import { MAX_TASKS, Settings } from "./settings.js";

/** What the task text writes to ask for its first upstream's output. */
export const PREVIOUS = "{previous}";

/** A task as the orchestrator wrote it. The tool schema decodes into this. */
export interface TaskInput {
  readonly id?: string;
  readonly needs?: readonly string[];
  /** The short label, for rows and messages. */
  readonly task: string;
  readonly prompt: string;
}

export interface PlannedTask {
  readonly id: string;
  /** Position in the call, so the caller can zip results back onto its own array. */
  readonly index: number;
  /** Zero-based. Every need sits in a strictly lower wave. */
  readonly wave: number;
  readonly needs: readonly string[];
  readonly task: string;
  readonly prompt: string;
}

export interface Settlement {
  readonly id: string;
  readonly index: number;
  /** Absent when the task produced nothing a dependent could use. */
  readonly output: string | undefined;
  /** The needs that produced no output. Non-empty means the task never ran. */
  readonly missing: readonly string[];
}

export class EmptyTaskList extends Schema.TaggedError<EmptyTaskList>()("EmptyTaskList", {}) {}

export class TooManyTasks extends Schema.TaggedError<TooManyTasks>()("TooManyTasks", {
  count: Schema.Number,
  limit: Schema.Number,
}) {}

export class InvalidTaskId extends Schema.TaggedError<InvalidTaskId>()("InvalidTaskId", {
  id: Schema.String,
  position: Schema.Number,
}) {}

export class DuplicateTaskId extends Schema.TaggedError<DuplicateTaskId>()("DuplicateTaskId", {
  id: Schema.String,
  /** True when the clash is with an id this module generated rather than a second explicit one. */
  generated: Schema.Boolean,
}) {}

export class UnknownNeed extends Schema.TaggedError<UnknownNeed>()("UnknownNeed", {
  task: Schema.String,
  need: Schema.String,
}) {}

export class SelfEdge extends Schema.TaggedError<SelfEdge>()("SelfEdge", {
  task: Schema.String,
}) {}

export class CyclicGraph extends Schema.TaggedError<CyclicGraph>()("CyclicGraph", {
  tasks: Schema.Array(Schema.String),
}) {}

export type GraphError =
  | EmptyTaskList
  | TooManyTasks
  | InvalidTaskId
  | DuplicateTaskId
  | UnknownNeed
  | SelfEdge
  | CyclicGraph;

export function formatGraphError(error: GraphError): string {
  switch (error._tag) {
    case "EmptyTaskList":
      return "No tasks were given. Pass at least one.";
    case "TooManyTasks":
      return `Too many tasks (${error.count}). The limit is ${error.limit}. Split the work, or ask the user to raise max tasks in /broodmother.`;
    case "InvalidTaskId":
      return `Task ${error.position} has the id "${error.id}". Ids may only contain letters, digits, underscore and hyphen.`;
    case "DuplicateTaskId":
      return error.generated
        ? `Task id "${error.id}" clashes with the id generated for a task that declared none. Give that task an explicit id, or rename this one.`
        : `Two tasks share the id "${error.id}". Ids address tasks in needs, so they have to be unique.`;
    case "UnknownNeed":
      return `Task "${error.task}" needs "${error.need}", which is not a task in this call.`;
    case "SelfEdge":
      return `Task "${error.task}" needs itself.`;
    case "CyclicGraph":
      return `These tasks need each other in a cycle, so none of them can start: ${error.tasks.join(", ")}.`;
  }
}

/**
 * Ids address tasks inside `needs` and end up in prompt headings, so the
 * charset is narrow on purpose. Decoded rather than regex-tested inline, the
 * same way the settings file is: this is where untrusted input becomes trusted.
 */
const decodeTaskId = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
);

function generatedId(index: number): string {
  return `task_${index + 1}`;
}

/**
 * Validation and wave assignment in one pass over the call, before a run
 * exists. Everything here is cheap and total, so a bad graph costs nothing and
 * the orchestrator gets one message naming what to fix.
 */
export const planGraph = Effect.fn("Graph.plan")(function* (
  inputs: readonly TaskInput[],
  limit: number = MAX_TASKS,
): Effect.fn.Return<readonly PlannedTask[], GraphError> {
  if (inputs.length === 0) {
    return yield* new EmptyTaskList();
  }
  if (inputs.length > limit) {
    return yield* new TooManyTasks({ count: inputs.length, limit });
  }

  const explicit = new Set<string>();
  for (const [position, input] of inputs.entries()) {
    if (input.id === undefined) {
      continue;
    }
    if (Option.isNone(decodeTaskId(input.id))) {
      return yield* new InvalidTaskId({ id: input.id, position: position + 1 });
    }
    if (explicit.has(input.id)) {
      return yield* new DuplicateTaskId({ id: input.id, generated: false });
    }
    explicit.add(input.id);
  }

  const ids: string[] = [];
  for (const [position, input] of inputs.entries()) {
    if (input.id !== undefined) {
      ids.push(input.id);
      continue;
    }
    // Renaming instead would break any `needs` already pointing at the explicit
    // one, and silently pointing an edge at a different task is worse than
    // refusing the call.
    const generated = generatedId(position);
    if (explicit.has(generated)) {
      return yield* new DuplicateTaskId({ id: generated, generated: true });
    }
    ids.push(generated);
  }

  const known = new Set(ids);
  const edges: (readonly string[])[] = [];
  for (const [position, input] of inputs.entries()) {
    const id = ids[position]!;
    const needs = [...new Set(input.needs ?? [])];
    for (const need of needs) {
      if (need === id) {
        return yield* new SelfEdge({ task: id });
      }
      if (!known.has(need)) {
        return yield* new UnknownNeed({ task: id, need });
      }
    }
    edges.push(needs);
  }

  return yield* layer(inputs, ids, edges);
});

/**
 * Kahn layering, which answers both questions the scheduler has: which wave
 * each task belongs to, and whether the graph has a cycle. A pass that assigns
 * nothing while tasks remain is the cycle, so there is no second walk.
 */
const layer = Effect.fn("Graph.layer")(function* (
  inputs: readonly TaskInput[],
  ids: readonly string[],
  edges: readonly (readonly string[])[],
): Effect.fn.Return<readonly PlannedTask[], CyclicGraph> {
  const waves = new Map<string, number>();
  const planned: PlannedTask[] = [];

  while (planned.length < ids.length) {
    const ready = ids
      .map((id, index) => ({ id, index }))
      .filter(({ id, index }) => !waves.has(id) && edges[index]!.every((need) => waves.has(need)));

    if (ready.length === 0) {
      return yield* new CyclicGraph({ tasks: ids.filter((id) => !waves.has(id)) });
    }

    const wave = Math.max(0, ...[...waves.values()].map((value) => value + 1));
    for (const { id, index } of ready) {
      planned.push({
        id,
        index,
        wave,
        needs: edges[index]!,
        task: inputs[index]!.task,
        prompt: inputs[index]!.prompt,
      });
    }
    // Assigned after the whole wave, so siblings land in the same one rather
    // than each pushing the next along.
    for (const { id } of ready) {
      waves.set(id, wave);
    }
  }

  return planned.sort((left, right) => left.index - right.index);
});

/**
 * Upstream delivery. Named blocks first so the child can tell two upstreams
 * apart, then the task text with `{previous}` filled in from the first need.
 * The orchestrator never copies a result between tasks, which is the whole
 * point of an edge: it cannot forget to pass what it never passes.
 */
export function composePrompt(
  prompt: string,
  needs: readonly string[],
  outputs: ReadonlyMap<string, string>,
): string {
  if (needs.length === 0) {
    if (!prompt.includes(PREVIOUS)) {
      return prompt;
    }
    // Saying so beats leaving a hole where the model expects a result.
    return `${prompt.replaceAll(PREVIOUS, () => "")}\n\n(${PREVIOUS} was empty: this task has no upstream.)`;
  }

  const first = outputs.get(needs[0]!) ?? "";
  const body = prompt.replaceAll(PREVIOUS, () => first);
  const blocks = needs.map((need) => `## Output of ${need}\n${outputs.get(need) ?? "(no output)"}`);
  return `${blocks.join("\n\n")}\n\n---\n\n${body}`;
}

/** Runs one task and reports what a dependent can use, or nothing. */
export type RunTask = (task: PlannedTask, prompt: string) => Effect.Effect<string | undefined>;

/**
 * The wave loop. Single, parallel and chain are three shapes of it rather than
 * three code paths.
 *
 * Gating is structural: `planGraph` already put every need in a strictly lower
 * wave, so a wave only ever reads outputs an earlier wave finished writing.
 * That leaves nothing mutating concurrently and no settled set to keep.
 *
 * `RunTask` cannot fail, and that is the design rather than an omission. A dead
 * child settles as a value, so its siblings keep running and its dependents
 * skip, instead of one bad task taking the batch down with it.
 */
export const runGraph = Effect.fn("Graph.run")(function* (
  plan: readonly PlannedTask[],
  runTask: RunTask,
) {
  const settings = yield* (yield* Settings).current;

  const outputs = new Map<string, string>();
  const settlements: Settlement[] = [];
  const lastWave = plan.reduce((highest, task) => Math.max(highest, task.wave), 0);

  for (let wave = 0; wave <= lastWave; wave++) {
    const ready = plan.filter((task) => task.wave === wave);

    const settled = yield* Effect.forEach(
      ready,
      Effect.fn("Graph.dispatch")(function* (task: PlannedTask) {
        const missing = task.needs.filter((need) => !outputs.has(need));
        // Never run against a prompt with a hole in it. The skip names the
        // needs that failed, so the parent can see the run's shape unravel.
        if (missing.length > 0) {
          return {
            id: task.id,
            index: task.index,
            output: undefined,
            missing,
          } satisfies Settlement;
        }

        const output = yield* runTask(task, composePrompt(task.prompt, task.needs, outputs));
        return { id: task.id, index: task.index, output, missing: [] } satisfies Settlement;
      }),
      { concurrency: settings.concurrency },
    );

    for (const settlement of settled) {
      settlements.push(settlement);
      if (settlement.output !== undefined) {
        outputs.set(settlement.id, settlement.output);
      }
    }
  }

  return settlements.sort((left, right) => left.index - right.index) as readonly Settlement[];
});
