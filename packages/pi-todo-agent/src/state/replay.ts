import { EMPTY_STATE, type TaskState } from "./state.js";
import type { TaskDetails } from "../tool/types.js";

/**
 * Discriminator for `details` envelopes that match the persisted TaskDetails
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: boundary check for TaskDetails; value is validated as object with
  // required fields before use.
  const v = value as { tasks?: unknown; nextId?: unknown };
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Structural view of one session-branch entry — the I/O boundary type for
 * replay. Only the message / toolResult / todo path matters; every field is
 * optional-unknown because session history arrives with an unknown shape,
 * and toolResultDetails validates the path field by field before use.
 */
export interface BranchEntry {
  type?: unknown;
  message?: { role?: unknown; toolName?: unknown; details?: unknown };
}

/**
 * Extract the TaskDetails snapshot from a branch entry, or undefined when
 * the entry is not a successful `todo` tool result with a well-shaped
 * snapshot.
 */
function toolResultDetails(entry: BranchEntry): TaskDetails | undefined {
  if (entry.type !== "message" || !entry.message) {
    return undefined;
  }
  if (entry.message.role !== "toolResult" || entry.message.toolName !== "todo") {
    return undefined;
  }
  return isTaskDetails(entry.message.details) ? entry.message.details : undefined;
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult`
 * whose `toolName === "todo"` and whose `details` shape-checks wins
 * (last-write-wins). No matching entry resolves to EMPTY_STATE.
 *
 * Pure of module state — the caller writes the returned snapshot into the
 * store after this returns; this function never touches it.
 */
export function replayFromBranch(ctx: {
  sessionManager: { getBranch(): Iterable<BranchEntry> };
}): TaskState {
  let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
  for (const entry of ctx.sessionManager.getBranch()) {
    const details = toolResultDetails(entry);
    if (!details) {
      continue;
    }
    result = {
      tasks: details.tasks.map((t) => ({ ...t })),
      nextId: details.nextId,
    };
  }
  return result;
}
