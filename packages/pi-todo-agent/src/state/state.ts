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
