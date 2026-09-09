import { describe, expect, it } from "vitest";
import { replayFromBranch, isTaskDetails, type BranchEntry } from "../../src/state/replay.js";
import { EMPTY_STATE, type TaskState } from "../../src/state/state.js";
import type { TaskDetails } from "../../src/tool/types.js";

function detailsSnapshot(overrides: Partial<TaskDetails> = {}): TaskDetails {
  return {
    action: "create",
    params: { action: "create", subject: "x" },
    tasks: [{ id: 1, subject: "one", status: "pending" }],
    nextId: 2,
    ...overrides,
  };
}

function branchOf(entries: BranchEntry[]): {
  sessionManager: { getBranch(): Iterable<BranchEntry> };
} {
  return { sessionManager: { getBranch: () => entries } };
}

function messageEntry(details: unknown, toolName = "todo"): BranchEntry {
  return {
    type: "message",
    message: { role: "toolResult", toolName, details },
  };
}

describe("isTaskDetails", () => {
  it("accepts the envelope snapshot shape", () => {
    expect(isTaskDetails(detailsSnapshot())).toBe(true);
  });

  it("rejects non-objects and shape mismatches", () => {
    expect(isTaskDetails(undefined)).toBe(false);
    expect(isTaskDetails("details")).toBe(false);
    expect(isTaskDetails({})).toBe(false);
    expect(isTaskDetails({ tasks: [] })).toBe(false);
    expect(isTaskDetails({ tasks: "nope", nextId: 1 })).toBe(false);
  });
});

describe("replayFromBranch", () => {
  it("returns EMPTY_STATE for a branch without todo results", () => {
    expect(replayFromBranch(branchOf([messageEntry({ foo: 1 }, "bash")]))).toEqual(EMPTY_STATE);
  });

  it("returns EMPTY_STATE for an empty branch", () => {
    expect(replayFromBranch(branchOf([]))).toEqual(EMPTY_STATE);
  });

  it("skips non-message entries and wrong tool names", () => {
    const entries = [
      { type: "summary", text: "compacted" },
      messageEntry(detailsSnapshot(), "bash"),
      { type: "message", message: { role: "assistant", content: "hi" } },
    ];
    expect(replayFromBranch(branchOf(entries))).toEqual(EMPTY_STATE);
  });

  it("skips entries whose details fail the shape guard", () => {
    const entries = [messageEntry({ tasks: "corrupt" }), messageEntry(detailsSnapshot())];
    const state = replayFromBranch(branchOf(entries));
    expect(state.tasks).toHaveLength(1);
  });

  it("last write wins", () => {
    const entries = [
      messageEntry(
        detailsSnapshot({ tasks: [{ id: 1, subject: "old", status: "pending" }], nextId: 2 }),
      ),
      messageEntry(
        detailsSnapshot({
          tasks: [
            { id: 1, subject: "old", status: "completed" },
            { id: 2, subject: "new", status: "pending" },
          ],
          nextId: 3,
        }),
      ),
    ];
    const state = replayFromBranch(branchOf(entries));
    expect(state.nextId).toBe(3);
    expect(state.tasks).toHaveLength(2);
  });

  it("returns a fresh copy, so mutating the replay output cannot alias the branch", () => {
    const details = detailsSnapshot();
    const state: TaskState = replayFromBranch(branchOf([messageEntry(details)]));
    state.tasks.push({ id: 99, subject: "injected", status: "pending" });
    expect(details.tasks).toHaveLength(1);
  });

  it("roundtrips a persisted snapshot back into an equal state", () => {
    const snapshot: TaskState = {
      tasks: [
        { id: 1, subject: "one", status: "completed" },
        { id: 2, subject: "two", status: "in_progress", activeForm: "working" },
        { id: 3, subject: "three", status: "pending", blockedBy: [2] },
      ],
      nextId: 4,
    };
    const entry = messageEntry({
      action: "update",
      params: { id: 2, status: "in_progress" },
      tasks: snapshot.tasks,
      nextId: snapshot.nextId,
    });
    expect(replayFromBranch(branchOf([entry]))).toEqual(snapshot);
  });
});
