import type { Task } from "../tool/types.js";

/**
 * Canonical state for the todo tool. Single source of truth — the reducer,
 * the live store, and replay all share this shape. Deliberately minimal: no
 * derived caches, selectors own every derivation.
 */
export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** Tasks excluding tombstones — the canonical "what's visible" across the tool
 * envelope, the overlay, and the flush predicate below. */
export function visibleTasks(state: TaskState): Task[] {
  return state.tasks.filter((t) => t.status !== "deleted");
}

/** True once every visible task is completed. False for an empty list — a
 * list with nothing in it is not a "done" list, just an unstarted one. */
export function isAllComplete(state: TaskState): boolean {
  const visible = visibleTasks(state);
  return visible.length > 0 && visible.every((t) => t.status === "completed");
}
