import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetState,
  commitState,
  getRenderState,
  getState,
  setActiveRenderSession,
  sid,
} from "../../src/state/store.js";
import { applyTaskMutation } from "../../src/state/state-reducer.js";
import { EMPTY_STATE, type TaskState } from "../../src/state/state.js";
import { buildToolResult } from "../../src/tool/response-envelope.js";
import type { TaskAction, TaskMutationParams, TodoParams } from "../../src/tool/types.js";

function fakeCtx(sessionId: string): Parameters<typeof sid>[0] {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function execute(state: TaskState, action: TaskAction, params: TaskMutationParams = {}) {
  const result = applyTaskMutation(state, action, params);
  // The host passes the full validated call params, action included.
  const fullParams: TodoParams = { action, ...params };
  return { result, envelope: buildToolResult(action, fullParams, result.state, result.op) };
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

beforeEach(() => {
  __resetState();
});

describe("formatContent per action", () => {
  it("formats a create echo", () => {
    const { envelope } = execute(EMPTY_STATE, "create", { subject: "write tests" });
    expect(envelope.content[0]?.text).toBe("Created #1: write tests (pending)");
  });

  it("formats an update transition echo", () => {
    // pending → in_progress keeps the list mid-flight, so no summary fires.
    const { envelope } = execute(withTasks([pending(1)]), "update", {
      id: 1,
      status: "in_progress",
    });
    expect(envelope.content[0]?.text).toBe("Updated #1 (pending → in_progress)");
  });

  it("formats a no-op update as no change", () => {
    const { envelope } = execute(withTasks([inProgress(1)]), "update", {
      id: 1,
      status: "in_progress",
    });
    expect(envelope.content[0]?.text).toBe(
      "No change: #1 already matches the requested values (status: in_progress)",
    );
  });

  it("formats a delete echo with the tombstoned subject", () => {
    const { envelope } = execute(withTasks([pending(1)]), "delete", { id: 1 });
    expect(envelope.content[0]?.text).toBe("Deleted #1: task 1");
  });

  it("formats a clear echo with the dropped count", () => {
    const { envelope } = execute(withTasks([pending(1), completed(2)]), "clear");
    expect(envelope.content[0]?.text).toBe("Cleared 2 tasks");
  });

  it("formats list lines with status, id, subject, and dependency suffix", () => {
    const state = withTasks([
      { id: 1, subject: "first", status: "pending", blockedBy: [2] },
      inProgress(2),
    ]);
    const second = state.tasks[1];
    if (!second) {
      throw new Error("test setup: task 2 missing");
    }
    second.activeForm = "testing";
    const { envelope } = execute(state, "list");
    expect(envelope.content[0]?.text).toBe(
      "[pending] #1 first ⛓ #2\n[in_progress] #2 task 2 (testing)",
    );
  });

  it("filters list by status and hides tombstones by default", () => {
    const state = withTasks([
      pending(1),
      completed(2),
      { id: 3, subject: "gone", status: "deleted" },
    ]);
    const { envelope } = execute(state, "list", { status: "completed" });
    expect(envelope.content[0]?.text).toBe("[completed] #2 task 2");
    const all = execute(state, "list");
    expect(all.envelope.content[0]?.text).toBe("[pending] #1 task 1\n[completed] #2 task 2");
    const everything = execute(state, "list", { includeDeleted: true });
    expect(everything.envelope.content[0]?.text).toContain("[deleted] #3 gone");
  });

  it("says No tasks for an empty list view", () => {
    const { envelope } = execute(EMPTY_STATE, "list");
    expect(envelope.content[0]?.text).toBe("No tasks");
  });

  it("formats get with detail rows and the reverse blocks line", () => {
    const state = withTasks([
      { id: 1, subject: "blocked one", status: "pending", blockedBy: [2] },
      { id: 2, subject: "root", status: "pending" },
      { id: 3, subject: "waiter", status: "pending", blockedBy: [1] },
    ]);
    const first = state.tasks[0];
    if (!first) {
      throw new Error("test setup: task 1 missing");
    }
    first.description = "long form";
    first.activeForm = "waiting";
    const { envelope } = execute(state, "get", { id: 1 });
    expect(envelope.content[0]?.text).toBe(
      [
        "#1 [pending] blocked one",
        "  description: long form",
        "  activeForm: waiting",
        "  blockedBy: #2",
        "  blocks: #3",
      ].join("\n"),
    );
  });

  it("formats the error branch with the in-band message", () => {
    const { envelope } = execute(EMPTY_STATE, "create", {});
    expect(envelope.content[0]?.text).toBe("Error: subject required for create");
  });
});

describe("all-done summary", () => {
  it("prepends the final list when a transition completes the last active task", () => {
    const state = withTasks([completed(1), completed(2), inProgress(3)]);
    const { envelope } = execute(state, "update", { id: 3, status: "completed" });
    expect(envelope.content[0]?.text).toBe(
      [
        "Updated #3 (in_progress → completed)",
        "",
        "All 3 tasks done:",
        "  ✓ #1 task 1",
        "  ✓ #2 task 2",
        "  ✓ #3 task 3",
      ].join("\n"),
    );
  });

  it("does not fire while any task is still pending or in progress", () => {
    const state = withTasks([pending(1), pending(2), inProgress(3)]);
    const { envelope } = execute(state, "update", { id: 1, status: "completed" });
    expect(envelope.content[0]?.text).toBe("Updated #1 (pending → completed)");
  });

  it("does not fire on list or get", () => {
    const state = withTasks([completed(1)]);
    const listed = execute(state, "list");
    expect(listed.envelope.content[0]?.text).toBe("[completed] #1 task 1");
    const got = execute(state, "get", { id: 1 });
    expect(got.envelope.content[0]?.text).toBe("#1 [completed] task 1");
  });

  it("fires when a delete removes the last active task", () => {
    const state = withTasks([completed(1), inProgress(2)]);
    const { envelope } = execute(state, "delete", { id: 2 });
    expect(envelope.content[0]?.text).toBe(
      ["Deleted #2: task 2", "", "All 1 tasks done:", "  ✓ #1 task 1"].join("\n"),
    );
  });

  it("sanitizes subjects in the summary", () => {
    const state = withTasks([{ id: 1, subject: "evil\u001b[31mstyled", status: "completed" }]);
    const { envelope } = execute(state, "update", { id: 1, status: "completed" });
    expect(envelope.content[0]?.text).toContain("✓ #1 evilstyled");
  });
});

describe("buildToolResult details snapshot", () => {
  it("carries the replay snapshot: action, params, tasks, nextId", () => {
    const { envelope } = execute(EMPTY_STATE, "create", { subject: "write tests" });
    expect(envelope.details).toEqual({
      action: "create",
      params: { action: "create", subject: "write tests" },
      tasks: [{ id: 1, subject: "write tests", status: "pending" }],
      nextId: 2,
    });
  });

  it("attaches the error message when the op failed", () => {
    const { envelope } = execute(EMPTY_STATE, "create", {});
    expect(envelope.details.error).toBe("subject required for create");
  });

  it("omits the error key on success so the snapshot stays byte-stable", () => {
    const { envelope } = execute(EMPTY_STATE, "create", { subject: "x" });
    expect(envelope.details).not.toHaveProperty("error");
  });
});

describe("execute -> store -> render roundtrip", () => {
  it("commits the reducer state under the calling session", () => {
    const ctx = fakeCtx("session-a");
    const { result } = execute(getState(sid(ctx)), "create", { subject: "first" });
    commitState(sid(ctx), result.state);
    expect(getState("session-a").tasks).toHaveLength(1);
  });

  it("renderCall reads the foreground slot without a ctx", () => {
    commitState("foreground", { tasks: [pending(1)], nextId: 2 });
    setActiveRenderSession("foreground");
    expect(getRenderState().tasks[0]?.subject).toBe("task 1");
  });
});
