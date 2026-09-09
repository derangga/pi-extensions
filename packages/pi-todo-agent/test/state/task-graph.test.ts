import { describe, expect, it } from "vitest";
import type { Task } from "../../src/tool/types.js";
import { deriveBlocks, detectCycle } from "../../src/state/task-graph.js";

function task(id: number, blockedBy?: number[]): Task {
  const t: Task = { id, subject: `task ${id}`, status: "pending" };
  if (blockedBy) {
    t.blockedBy = blockedBy;
  }
  return t;
}

describe("detectCycle", () => {
  it("accepts an acyclic merge", () => {
    const tasks = [task(1, [3]), task(2), task(3)];
    expect(detectCycle(tasks, 2, [1])).toBe(false);
  });

  it("rejects a direct two-node cycle", () => {
    const tasks = [task(1, [2]), task(2)];
    expect(detectCycle(tasks, 2, [1])).toBe(true);
  });

  it("rejects a cycle through a longer chain", () => {
    // 3 -> 1 -> 2 -> 3 closes the loop when 3 gains a blockedBy on 1.
    const tasks = [task(1, [2]), task(2, [3]), task(3)];
    expect(detectCycle(tasks, 3, [1])).toBe(true);
  });

  it("accepts a diamond without a cycle", () => {
    // 4 waits on 2 and 3; both wait on 1. Shared ancestry is not a cycle.
    const tasks = [task(1), task(2, [1]), task(3, [1]), task(4)];
    expect(detectCycle(tasks, 4, [2, 3])).toBe(false);
  });

  it("ignores tasks with no role in the merge", () => {
    const tasks = [task(1), task(2), task(3, [1])];
    expect(detectCycle(tasks, 3, [2])).toBe(false);
  });
});

describe("deriveBlocks", () => {
  it("inverts blockedBy into blocks", () => {
    const tasks = [task(1, [3]), task(2, [3]), task(3)];
    const blocks = deriveBlocks(tasks);
    expect(blocks.get(3)).toEqual([1, 2]);
    expect(blocks.get(1)).toBeUndefined();
  });

  it("returns an empty map for a flat list", () => {
    expect([...deriveBlocks([task(1), task(2)])]).toEqual([]);
  });
});
