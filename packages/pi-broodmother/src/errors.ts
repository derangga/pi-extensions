import { Schema } from "effect";

/**
 * Every tagged error the package can surface, grouped by the module that
 * produces it, plus the unions and the formatters that render them into what
 * a tool result reads. One file, because a reader asks two questions of
 * failures (what can fail, and what the user then sees) and both used to need
 * three answers. Nothing here imports from the modules themselves: every
 * field is a Schema primitive, so there is no cycle to manage.
 *
 * `ChildRunFailed` is deliberately absent. It is lifecycle's own implementation
 * detail, caught before it can escape into the graph scheduler, and keeping it
 * unexported there is what makes a future second lifecycle error a visible
 * type error instead of a silent fold.
 */

// --- settings ----------------------------------------------------------------

export class SettingsWriteError extends Schema.TaggedError<SettingsWriteError>()(
  "SettingsWriteError",
  { path: Schema.String, message: Schema.String },
) {}

/**
 * The one failure reading the settings file can produce. Typed here, at the
 * boundary, so nothing downstream pattern-matches an `unknown` or probes a
 * Node error object for its `code`: the catch decides whether the file was
 * merely absent and carries that answer on the error itself.
 */
export class SettingsReadError extends Schema.TaggedError<SettingsReadError>()(
  "SettingsReadError",
  { path: Schema.String, message: Schema.String, missing: Schema.Boolean },
) {}

// --- graph -------------------------------------------------------------------

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

// --- resolve -----------------------------------------------------------------

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()("ModelNotFound", {
  task: Schema.String,
  ref: Schema.String,
  available: Schema.Array(Schema.String),
}) {}

export class ThinkingUnsupported extends Schema.TaggedError<ThinkingUnsupported>()(
  "ThinkingUnsupported",
  {
    task: Schema.String,
    agent: Schema.String,
    model: Schema.String,
    level: Schema.String,
    supported: Schema.Array(Schema.String),
  },
) {}

export class NoModelAvailable extends Schema.TaggedError<NoModelAvailable>()("NoModelAvailable", {
  task: Schema.String,
  reason: Schema.String,
}) {}

export type ResolveError = ModelNotFound | ThinkingUnsupported | NoModelAvailable;

export function formatResolveError(error: ResolveError): string {
  switch (error._tag) {
    case "ModelNotFound":
      return `Task "${error.task}": model not found: "${error.ref}".\n\nAvailable models:\n${error.available
        .map((id) => `  ${id}`)
        .join("\n")}`;
    case "ThinkingUnsupported": {
      const who = error.agent ? `agent "${error.agent}"` : "no agent";
      const supported = error.supported.length > 0 ? error.supported.join(" | ") : "none";
      return `Task "${error.task}" (${who}): thinking level "${error.level}" is not supported by ${error.model}. Supported: ${supported}.`;
    }
    case "NoModelAvailable":
      return `Task "${error.task}": ${error.reason}`;
  }
}

// --- manager -----------------------------------------------------------------

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

/**
 * The one place a typed manager failure becomes something the model reads.
 * Pi turns a thrown tool error into an error tool result carrying the
 * message, which is exactly where these belong.
 */
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
