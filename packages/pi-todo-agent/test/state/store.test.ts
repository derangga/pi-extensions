import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetState,
  clearActiveRenderSession,
  commitState,
  evictSession,
  getRenderState,
  getState,
  replaceState,
  seedFlushState,
  setActiveRenderSession,
  sid,
  takeFlushEdge,
} from "../../src/state/store.js";
import type { Task } from "../../src/tool/types.js";

function task(id: number, status: Task["status"] = "pending"): Task {
  return { id, subject: `task ${id}`, status };
}

function fakeCtx(sessionId: string): Parameters<typeof sid>[0] {
  return { sessionManager: { getSessionId: () => sessionId } };
}

beforeEach(() => {
  __resetState();
});

describe("sid", () => {
  it("reads the session id from the ctx", () => {
    expect(sid(fakeCtx("session-a"))).toBe("session-a");
  });

  it("resolves an unknown session to the empty-string slot", () => {
    expect(sid(fakeCtx(""))).toBe("");
  });
});

describe("per-session slots", () => {
  it("gives each session its own state", () => {
    commitState("session-a", { tasks: [task(1)], nextId: 2 });
    commitState("session-b", { tasks: [task(1), task(2)], nextId: 3 });
    expect(getState("session-a").tasks).toHaveLength(1);
    expect(getState("session-b").tasks).toHaveLength(2);
  });

  it("isolates a child session from the parent's list", () => {
    commitState("parent", { tasks: [task(1)], nextId: 2 });
    commitState("child", { tasks: [], nextId: 1 });
    expect(getState("parent").tasks).toHaveLength(1);
    expect(getState("child").tasks).toHaveLength(0);
  });

  it("returns a fresh empty state for an unknown session without storing it", () => {
    expect(getState("missing").tasks).toEqual([]);
    expect(getState("missing").nextId).toBe(1);
  });

  it("returns copies, so callers cannot mutate the live slot", () => {
    commitState("session-a", { tasks: [task(1)], nextId: 2 });
    const snapshot = getState("session-a");
    snapshot.tasks.push(task(99));
    expect(getState("session-a").tasks).toHaveLength(1);
  });
});

describe("lifecycle seams", () => {
  it("replaceState installs a replay snapshot", () => {
    replaceState("session-a", { tasks: [task(1, "completed")], nextId: 5 });
    expect(getState("session-a").nextId).toBe(5);
  });

  it("evictSession drops the slot", () => {
    commitState("session-a", { tasks: [task(1)], nextId: 2 });
    evictSession("session-a");
    expect(getState("session-a").tasks).toEqual([]);
  });

  it("evictSession is a no-op for an absent slot", () => {
    expect(() => evictSession("missing")).not.toThrow();
  });
});

describe("flush latch", () => {
  it("fires only on the not-all-complete to all-complete transition", () => {
    expect(takeFlushEdge("s1", false)).toBe(false);
    expect(takeFlushEdge("s1", true)).toBe(true);
    // Already latched: another mutating call on the finished list doesn't
    // re-fire.
    expect(takeFlushEdge("s1", true)).toBe(false);
  });

  it("re-arms after dropping back to not-all-complete", () => {
    expect(takeFlushEdge("s1", true)).toBe(true);
    expect(takeFlushEdge("s1", false)).toBe(false);
    expect(takeFlushEdge("s1", true)).toBe(true);
  });

  it("tracks sessions independently", () => {
    expect(takeFlushEdge("a", true)).toBe(true);
    expect(takeFlushEdge("b", true)).toBe(true);
  });

  it("seedFlushState records the latch without ever reporting an edge", () => {
    seedFlushState("s1", true);
    // Replay seeded true → true is not a transition, so the next real call
    // with true must not re-fire either.
    expect(takeFlushEdge("s1", true)).toBe(false);
  });

  it("evictSession clears the latch", () => {
    takeFlushEdge("s1", true);
    evictSession("s1");
    expect(takeFlushEdge("s1", true)).toBe(true);
  });

  it("__resetState clears the latch", () => {
    takeFlushEdge("s1", true);
    __resetState();
    expect(takeFlushEdge("s1", true)).toBe(true);
  });
});

describe("render pointer", () => {
  it("defaults to the empty slot", () => {
    expect(getRenderState().tasks).toEqual([]);
  });

  it("resolves to the claimed foreground slot", () => {
    commitState("foreground", { tasks: [task(1)], nextId: 2 });
    commitState("background", { tasks: [task(1), task(2)], nextId: 3 });
    setActiveRenderSession("foreground");
    expect(getRenderState().tasks).toHaveLength(1);
    setActiveRenderSession("background");
    expect(getRenderState().tasks).toHaveLength(2);
    clearActiveRenderSession();
    expect(getRenderState().tasks).toEqual([]);
  });
});
