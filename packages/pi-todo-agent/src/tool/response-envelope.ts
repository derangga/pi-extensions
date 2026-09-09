import { deriveBlocks } from "../state/task-graph.js";
import type { Op } from "../state/state-reducer.js";
import type { TaskState } from "../state/state.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { Task, TaskAction, TaskDetails, TodoParams } from "./types.js";

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch; the overlay renders its own rows.
 */
function formatListLine(t: Task): string {
  const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form =
    t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
  return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action: header, description,
 * activeForm, blockedBy, blocks (reverse edges derived from the other tasks).
 */
function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
  if (task.description) {
    lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
  }
  if (task.activeForm) {
    lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
  }
  if (task.blockedBy?.length) {
    lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (blocks.length) {
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** Tasks excluding tombstones — the canonical "what's visible". */
function visibleTasks(state: TaskState): Task[] {
  return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * When a mutation leaves every visible task completed, the result carries
 * the full final list. Without it, the list would exist only in the overlay
 * (which fades completed rows) and nowhere in the chat transcript.
 */
function allDoneSummary(state: TaskState): string | undefined {
  const visible = visibleTasks(state);
  if (visible.length === 0 || visible.some((t) => t.status !== "completed")) {
    return undefined;
  }
  const lines = [`All ${visible.length} tasks done:`];
  for (const t of visible) {
    lines.push(`  ✓ #${t.id} ${sanitizeTerminalText(t.subject)}`);
  }
  return lines.join("\n");
}

/**
 * Pure formatter: (op, state) → string. A closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 */
export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      // Defensive — op.taskId always resolves on the success path.
      if (!t) {
        return `Created #${op.taskId}`;
      }
      return `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`;
    }
    case "update": {
      if (!op.changed) {
        return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
      }
      const transition =
        op.fromStatus === op.toStatus ? "" : ` (${op.fromStatus} → ${op.toStatus})`;
      return `Updated #${op.id}${transition}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) {
        view = view.filter((t) => t.status !== "deleted");
      }
      if (op.statusFilter) {
        view = view.filter((t) => t.status === op.statusFilter);
      }
      return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
    default: {
      // Op is a closed union, so this is unreachable today; the clause keeps
      // the switch total if a future variant lands without its format branch.
      return "Error: unknown operation";
    }
  }
}

/** Action kinds that change task state; only these can produce the summary. */
const MUTATING_ACTIONS: ReadonlySet<TaskAction> = new Set(["create", "update", "delete"]);

/**
 * The model-facing tool result: transcript text plus the persistence +
 * replay snapshot. Named contract so callers (the tool's execute hook and
 * the tests) share one owner type.
 */
export interface TodoToolEnvelope {
  content: Array<{ type: "text"; text: string }>;
  details: TaskDetails;
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot:
 * replay consumes this exact shape from the session branch on session
 * lifecycle events.
 */
export function buildToolResult(
  action: TaskAction,
  params: TodoParams,
  state: TaskState,
  op: Op,
): TodoToolEnvelope {
  const body = formatContent(op, state);
  const summary = MUTATING_ACTIONS.has(action) ? allDoneSummary(state) : undefined;
  const text = summary ? `${body}\n\n${summary}` : body;
  const details: TaskDetails = {
    action,
    params,
    tasks: state.tasks,
    nextId: state.nextId,
  };
  if (op.kind === "error") {
    details.error = op.message;
  }
  return { content: [{ type: "text", text }], details };
}
