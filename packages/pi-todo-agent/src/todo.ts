/**
 * todo tool — thin registration shell. The reducer, store, and envelope own
 * the semantics; this file is the package-root surface that binds them to
 * the ExtensionAPI. Todo state is a shared per-session cell, so the tool
 * registers as sequential and every execute closes over the store's
 * per-session commit queue.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getRenderState, getState, runExclusive, sid } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import { TOOL_LABEL, TOOL_NAME, TodoParamsSchema, type TaskAction } from "./tool/types.js";
import { sanitizeTerminalText } from "./tool/sanitize.js";

// ---------------------------------------------------------------------------
// Prompt copy. Hardcoded by design — this package has no config file. Every
// line teaches the model one behavior of the tool.
// ---------------------------------------------------------------------------

const PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

const PROMPT_GUIDELINES: string[] = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"}. status is the field that changes the task; an update without a mutable field (status, subject, description, activeForm, or the blockedBy sets) is rejected.',
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

/** Per-action prefix glyph for renderCall: `+` create, `→` update, `×` delete, `›` get, `☰` list, `∅` clear. */
const ACTION_GLYPH: Record<TaskAction, string> = {
  create: "+",
  update: "→",
  delete: "×",
  get: "›",
  list: "☰",
  clear: "∅",
};

function taskSubjectById(id: number): string | undefined {
  return getRenderState().tasks.find((t) => t.id === id)?.subject;
}

export function registerTodoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,
    // Todo state is a module-level per-session cell, not per-call local data:
    // two todo calls in one batch must not read the same snapshot and race
    // their commits. Sequential execution keeps the batch ordered; the
    // store's runExclusive queue enforces the same invariant on its own.
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = sid(ctx);
      return runExclusive(sessionId, () => {
        const result = applyTaskMutation(getState(sessionId), params.action, params);
        commitState(sessionId, result.state);
        return buildToolResult(params.action, params, result.state, result.op);
      });
    },

    // renderCall reflects the FOREGROUND slot: the ctx-less render pointer.
    // A detached/child call whose task lives only in the child's slot falls
    // back to `#<id>` — per-session ids restart at 1, so searching sibling
    // slots could surface the wrong subject.
    renderCall(args, theme) {
      const glyph = ACTION_GLYPH[args.action] ?? args.action;
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);
      if (
        (args.action === "create" ||
          args.action === "update" ||
          args.action === "delete" ||
          args.action === "get") &&
        args.subject !== undefined
      ) {
        text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
      } else if (args.id !== undefined) {
        const subject = taskSubjectById(args.id);
        text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
      } else if (args.action === "list" && args.status !== undefined) {
        text += ` ${theme.fg("muted", args.status)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
