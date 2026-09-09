import { beforeEach, describe, expect, it } from "vitest";
import { applyTaskMutation, type Op } from "../../src/state/state-reducer.js";
import { EMPTY_STATE, type TaskState } from "../../src/state/state.js";
import type { TaskAction, TaskMutationParams } from "../../src/tool/types.js";

function run(state: TaskState, action: TaskAction, params: TaskMutationParams = {}) {
  return applyTaskMutation(state, action, params);
}

function withTasks(tasks: TaskState["tasks"], nextId = tasks.length + 1): TaskState {
  return { tasks, nextId };
}

function pending(id: number, subject = `task ${id}`): TaskState["tasks"][number] {
  return { id, subject, status: "pending" };
}

function inProgress(id: number): TaskState["tasks"][number] {
  return { id, subject: `task ${id}`, status: "in_progress" };
}

function completed(id: number): TaskState["tasks"][number] {
  return { id, subject: `task ${id}`, status: "completed" };
}

function blocked(id: number, deps: number[]): TaskState["tasks"][number] {
  return { id, subject: `task ${id}`, status: "pending", blockedBy: deps };
}

beforeEach(() => {});

describe("create", () => {
  it("appends a pending task with the next id", () => {
    const { state, op } = run(EMPTY_STATE, "create", { subject: "write tests" });
    expect(op).toEqual({ kind: "create", taskId: 1 });
    expect(state.tasks).toEqual([{ id: 1, subject: "write tests", status: "pending" }]);
    expect(state.nextId).toBe(2);
  });

  it("keeps optional fields when provided", () => {
    // Seed task 2 so the blockedBy reference resolves.
    const state: TaskState = {
      tasks: [{ id: 2, subject: "deploy dep", status: "pending" }],
      nextId: 3,
    };
    const { state: next } = run(state, "create", {
      subject: "deploy",
      description: "ship it",
      activeForm: "deploying",
      blockedBy: [2],
    });
    expect(next.tasks[1]).toEqual({
      id: 3,
      subject: "deploy",
      description: "ship it",
      activeForm: "deploying",
      status: "pending",
      blockedBy: [2],
    });
    expect(next.nextId).toBe(4);
  });

  it("rejects a missing or blank subject without mutating state", () => {
    for (const subject of [undefined, "", "   "]) {
      const { state, op } = run(EMPTY_STATE, "create", subject === undefined ? {} : { subject });
      expect(op).toEqual({ kind: "error", message: "subject required for create" });
      expect(state).toEqual(EMPTY_STATE);
    }
  });

  it("rejects an unknown blockedBy id", () => {
    const { state, op } = run(withTasks([pending(1)]), "create", {
      subject: "new",
      blockedBy: [9],
    });
    expect(op).toEqual({ kind: "error", message: "blockedBy: #9 not found" });
    expect(state.tasks).toHaveLength(1);
  });

  it("rejects a deleted blockedBy target", () => {
    const tasks = [pending(1), { id: 2, subject: "gone", status: "deleted" as const }];
    const { op } = run(withTasks(tasks), "create", { subject: "new", blockedBy: [2] });
    expect(op).toEqual({ kind: "error", message: "blockedBy: #2 is deleted" });
  });
});

describe("update", () => {
  it("moves status through a legal transition", () => {
    const state = withTasks([inProgress(1)]);
    const { state: next, op } = run(state, "update", { id: 1, status: "completed" });
    expect(op).toEqual({
      kind: "update",
      id: 1,
      fromStatus: "in_progress",
      toStatus: "completed",
      changed: true,
    });
    expect(next.tasks[0]?.status).toBe("completed");
  });

  it("rejects an illegal transition", () => {
    const state = withTasks([completed(1)]);
    const { state: next, op } = run(state, "update", { id: 1, status: "in_progress" });
    expect(op).toEqual({ kind: "error", message: "illegal transition completed → in_progress" });
    expect(next.tasks[0]?.status).toBe("completed");
  });

  it("reports a same-to-same status as a no-op change", () => {
    const state = withTasks([inProgress(1)]);
    const { op } = run(state, "update", { id: 1, status: "in_progress" });
    expect(op).toMatchObject({
      kind: "update",
      changed: false,
      fromStatus: "in_progress",
      toStatus: "in_progress",
    });
  });

  it("rejects an update with no mutable field", () => {
    const { op } = run(withTasks([pending(1)]), "update", { id: 1 });
    expect(op).toEqual({
      kind: "error",
      message:
        "update requires at least one mutable field: subject, description, activeForm, status, addBlockedBy, or removeBlockedBy",
    });
  });

  it("rejects an unknown id", () => {
    const { op } = run(EMPTY_STATE, "update", { id: 7, status: "completed" });
    expect(op).toEqual({ kind: "error", message: "#7 not found" });
  });

  it("requires an id", () => {
    const { op } = run(withTasks([pending(1)]), "update", { status: "completed" });
    expect(op).toEqual({ kind: "error", message: "id required for update" });
  });

  it("edits fields and clears them with empty strings", () => {
    const state = withTasks([
      { id: 1, subject: "old", description: "old text", status: "pending" },
    ]);
    const { state: next, op } = run(state, "update", { id: 1, subject: "new", description: "" });
    expect(op).toMatchObject({ kind: "update", changed: true });
    expect(next.tasks[0]).toEqual({ id: 1, subject: "new", description: "", status: "pending" });
  });

  it("merges addBlockedBy additively and keeps insertion order", () => {
    const state = withTasks([blocked(1, [2]), pending(2), pending(3)]);
    const { state: next } = run(state, "update", { id: 1, addBlockedBy: [3, 2] });
    expect(next.tasks[0]?.blockedBy).toEqual([2, 3]);
  });

  it("removes removeBlockedBy ids", () => {
    const state = withTasks([blocked(1, [2, 3])]);
    const { state: next } = run(state, "update", { id: 1, removeBlockedBy: [2] });
    expect(next.tasks[0]?.blockedBy).toEqual([3]);
  });

  it("drops the blockedBy field when the set empties", () => {
    const state = withTasks([blocked(1, [2])]);
    const { state: next } = run(state, "update", { id: 1, removeBlockedBy: [2] });
    expect(next.tasks[0]).not.toHaveProperty("blockedBy");
  });

  it("rejects a self-block", () => {
    const { op } = run(withTasks([pending(1)]), "update", { id: 1, addBlockedBy: [1] });
    expect(op).toEqual({ kind: "error", message: "cannot block #1 on itself" });
  });

  it("rejects unknown and deleted addBlockedBy targets", () => {
    const state = withTasks([pending(1), { id: 2, subject: "gone", status: "deleted" }]);
    const unknown = run(state, "update", { id: 1, addBlockedBy: [9] });
    expect(unknown.op).toEqual({ kind: "error", message: "addBlockedBy: #9 not found" });
    const deleted = run(state, "update", { id: 1, addBlockedBy: [2] });
    expect(deleted.op).toEqual({ kind: "error", message: "addBlockedBy: #2 is deleted" });
  });

  it("rejects an addBlockedBy that would close a cycle", () => {
    const state = withTasks([blocked(1, [2]), blocked(2, [3]), pending(3)]);
    const { state: next, op } = run(state, "update", { id: 3, addBlockedBy: [1] });
    expect(op).toEqual({
      kind: "error",
      message: "addBlockedBy would create a cycle in the blockedBy graph",
    });
    expect(next).toEqual(state);
  });

  it("reports a no-op when nothing actually changed", () => {
    const state = withTasks([blocked(1, [2]), pending(2)]);
    const { op } = run(state, "update", { id: 1, addBlockedBy: [2] });
    expect(op).toEqual({
      kind: "update",
      id: 1,
      fromStatus: "pending",
      toStatus: "pending",
      changed: false,
    });
  });
});

describe("delete", () => {
  it("tombstones without removing the row", () => {
    const state = withTasks([pending(1), pending(2)]);
    const { state: next, op } = run(state, "delete", { id: 1 });
    expect(op).toEqual({ kind: "delete", id: 1, subject: "task 1" });
    expect(next.tasks[0]).toEqual({ id: 1, subject: "task 1", status: "deleted" });
    expect(next.nextId).toBe(3);
  });

  it("rejects deleting an already-deleted task", () => {
    const tasks = [{ ...pending(1), status: "deleted" as const }];
    const { op } = run(withTasks(tasks), "delete", { id: 1 });
    expect(op).toEqual({ kind: "error", message: "#1 is already deleted" });
  });

  it("rejects an unknown id and a missing id", () => {
    expect(run(EMPTY_STATE, "delete", { id: 5 }).op).toEqual({
      kind: "error",
      message: "#5 not found",
    });
    expect(run(withTasks([pending(1)]), "delete", {}).op).toEqual({
      kind: "error",
      message: "id required for delete",
    });
  });
});

describe("clear", () => {
  it("empties the list and resets the id counter", () => {
    const state = withTasks(
      [pending(1), completed(2), { id: 3, subject: "x", status: "deleted" }],
      4,
    );
    const { state: next, op } = run(state, "clear");
    expect(op).toEqual({ kind: "clear", count: 3 });
    expect(next).toEqual({ tasks: [], nextId: 1 });
  });
});

describe("list", () => {
  it("hides tombstones by default and filters by status", () => {
    const state = withTasks([pending(1), completed(2), { id: 3, subject: "x", status: "deleted" }]);
    const { op } = run(state, "list");
    expect(op).toEqual({ kind: "list", includeDeleted: false });

    const filtered = run(state, "list", { status: "pending" });
    expect(filtered.op).toEqual({ kind: "list", statusFilter: "pending", includeDeleted: false });
  });

  it("passes includeDeleted through", () => {
    const { op } = run(withTasks([pending(1)]), "list", { includeDeleted: true });
    expect(op).toEqual({ kind: "list", includeDeleted: true });
  });
});

describe("get", () => {
  it("returns the task", () => {
    const state = withTasks([blocked(1, [2])]);
    const { op } = run(state, "get", { id: 1 });
    expect(op).toEqual({ kind: "get", task: state.tasks[0] });
  });

  it("resolves tombstones so history stays readable", () => {
    const tasks = [{ id: 1, subject: "gone", status: "deleted" as const }];
    const { op } = run(withTasks(tasks), "get", { id: 1 });
    expect(op).toEqual({ kind: "get", task: tasks[0] });
  });

  it("rejects unknown and missing ids", () => {
    expect(run(EMPTY_STATE, "get", { id: 4 }).op).toEqual({
      kind: "error",
      message: "#4 not found",
    });
    expect(run(withTasks([pending(1)]), "get", {}).op).toEqual({
      kind: "error",
      message: "id required for get",
    });
  });
});

describe("Op union", () => {
  it("stays closed over the six actions plus error", () => {
    const kinds: Op["kind"][] = ["create", "update", "delete", "list", "get", "clear", "error"];
    expect(kinds).toHaveLength(7);
  });
});
