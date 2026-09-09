import { describe, expect, it } from "vitest";
import { isTransitionValid, VALID_TRANSITIONS } from "../../src/state/invariants.js";

describe("VALID_TRANSITIONS", () => {
  it("allows forward progress from pending", () => {
    expect([...VALID_TRANSITIONS.pending].sort((a, b) => a.localeCompare(b))).toEqual([
      "completed",
      "deleted",
      "in_progress",
    ]);
  });

  it("allows pending, completed, and deleted from in_progress", () => {
    expect([...VALID_TRANSITIONS.in_progress].sort((a, b) => a.localeCompare(b))).toEqual([
      "completed",
      "deleted",
      "pending",
    ]);
  });

  it("makes completed one-way to deleted only", () => {
    // A completed task never goes back to work; reopening means a new task.
    expect([...VALID_TRANSITIONS.completed]).toEqual(["deleted"]);
  });

  it("makes deleted terminal", () => {
    expect([...VALID_TRANSITIONS.deleted]).toEqual([]);
  });
});

describe("isTransitionValid", () => {
  it("accepts same-to-same as an idempotent no-op", () => {
    for (const status of ["pending", "in_progress", "completed", "deleted"] as const) {
      expect(isTransitionValid(status, status)).toBe(true);
    }
  });

  it("accepts each table transition", () => {
    expect(isTransitionValid("pending", "in_progress")).toBe(true);
    expect(isTransitionValid("pending", "completed")).toBe(true);
    expect(isTransitionValid("pending", "deleted")).toBe(true);
    expect(isTransitionValid("in_progress", "pending")).toBe(true);
    expect(isTransitionValid("in_progress", "completed")).toBe(true);
    expect(isTransitionValid("in_progress", "deleted")).toBe(true);
    expect(isTransitionValid("completed", "deleted")).toBe(true);
  });

  it("rejects reopening a completed task", () => {
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
    expect(isTransitionValid("completed", "pending")).toBe(false);
  });

  it("rejects resurrecting a deleted task", () => {
    expect(isTransitionValid("deleted", "pending")).toBe(false);
    expect(isTransitionValid("deleted", "in_progress")).toBe(false);
    expect(isTransitionValid("deleted", "completed")).toBe(false);
  });
});
