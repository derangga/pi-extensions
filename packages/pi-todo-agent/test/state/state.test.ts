import { describe, expect, it } from "vitest";
import { EMPTY_STATE, isAllComplete, visibleTasks, type TaskState } from "../../src/state/state.js";
import type { Task } from "../../src/tool/types.js";

function withTasks(tasks: Task[]): TaskState {
  return { tasks, nextId: tasks.length + 1 };
}

describe("visibleTasks", () => {
  it("drops tombstones", () => {
    const state = withTasks([
      { id: 1, subject: "kept", status: "pending" },
      { id: 2, subject: "gone", status: "deleted" },
    ]);
    expect(visibleTasks(state).map((t) => t.id)).toEqual([1]);
  });
});

describe("isAllComplete", () => {
  it("is false for an empty list", () => {
    expect(isAllComplete(EMPTY_STATE)).toBe(false);
  });

  it("is false while any visible task is pending or in progress", () => {
    const state = withTasks([
      { id: 1, subject: "one", status: "completed" },
      { id: 2, subject: "two", status: "in_progress" },
    ]);
    expect(isAllComplete(state)).toBe(false);
  });

  it("is true once every visible task is completed", () => {
    const state = withTasks([
      { id: 1, subject: "one", status: "completed" },
      { id: 2, subject: "two", status: "completed" },
    ]);
    expect(isAllComplete(state)).toBe(true);
  });

  it("ignores tombstones: completed plus deleted still counts as done", () => {
    const state = withTasks([
      { id: 1, subject: "one", status: "completed" },
      { id: 2, subject: "gone", status: "deleted" },
    ]);
    expect(isAllComplete(state)).toBe(true);
  });
});
