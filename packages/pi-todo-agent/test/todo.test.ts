import type { Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import defaultExtension from "../src/index.js";
import { registerTodoTool } from "../src/todo.js";
import { __resetState, commitState, getRenderState, getState } from "../src/state/store.js";
import { TOOL_LABEL, TOOL_NAME, TodoParamsSchema, type TaskDetails } from "../src/tool/types.js";

type Handler = (...args: never[]) => unknown;

interface MockPi {
  tools: Array<{
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    executionMode?: string;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: MockCtx,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: TaskDetails }>;
    renderCall?: (args: unknown, theme: MockTheme, context: unknown) => Text;
  }>;
  handlers: Map<string, Handler>;
  registerTool(tool: MockPi["tools"][number]): void;
  on(event: string, handler: Handler): void;
}

interface MockTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface MockCtx {
  hasUI: boolean;
  ui: ReturnType<typeof mockUI>;
  sessionManager: {
    getSessionId(): string;
    getBranch(): object[];
  };
}

/** Unwrap an optional test fixture or fail loudly at the exact spot. */
function must<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

function mockTheme(): MockTheme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
}

interface MockWidget {
  key: string;
  factory: unknown;
  options?: { placement?: string } | undefined;
}

/** Minimal ExtensionUIContext stand-in: captures setWidget calls. */
function mockUI(): {
  theme: object;
  widgets: MockWidget[];
  setWidget(key: string, content: unknown, options?: { placement?: string }): void;
} {
  const ui = {
    theme: {},
    widgets: [] as MockWidget[],
    setWidget(key: string, content: unknown, options?: { placement?: string }) {
      const existing = ui.widgets.find((w) => w.key === key);
      if (existing) {
        existing.factory = content;
        if (options !== undefined) {
          existing.options = options;
        }
        return;
      }
      ui.widgets.push(
        options === undefined ? { key, factory: content } : { key, factory: content, options },
      );
    },
  };
  return ui;
}

function mockCtx(sessionId: string, branch: object[] = [], hasUI = true): MockCtx {
  return {
    hasUI,
    ui: mockUI(),
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  };
}

function makePi(): MockPi {
  const pi: MockPi = {
    tools: [],
    handlers: new Map(),
    registerTool(tool) {
      pi.tools.push(tool);
    },
    on(event, handler) {
      pi.handlers.set(event, handler);
    },
  };
  return pi;
}

function detailsEntry(details: TaskDetails): object {
  return { type: "message", message: { role: "toolResult", toolName: "todo", details } };
}

beforeEach(() => {
  __resetState();
});

describe("registerTodoTool", () => {
  it("registers the todo tool with schema, guidance, and render hooks", () => {
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.label).toBe(TOOL_LABEL);
    expect(tool.parameters).toBe(TodoParamsSchema);
    expect(tool.promptSnippet?.length ?? 0).toBeGreaterThan(0);
    expect(tool.promptGuidelines?.length ?? 0).toBeGreaterThan(0);
    // Todo state is a shared per-session cell: the host must not run todo
    // calls in a batch concurrently.
    expect(tool.executionMode).toBe("sequential");
    expect(typeof tool.renderCall).toBe("function");
  });

  it("executes against the calling session's slot and commits the result", async () => {
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const result = await tool.execute(
      "call-1",
      { action: "create", subject: "write tests" },
      undefined,
      undefined,
      mockCtx("s1"),
    );
    expect(result.content[0]?.text).toBe("Created #1: write tests (pending)");
    expect(result.details.nextId).toBe(2);
    expect(getState("s1").tasks).toHaveLength(1);
  });

  it("executes an error branch without mutating the slot", async () => {
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const result = await tool.execute(
      "call-1",
      { action: "create" },
      undefined,
      undefined,
      mockCtx("s1"),
    );
    expect(result.content[0]?.text).toBe("Error: subject required for create");
    expect(result.details.error).toBe("subject required for create");
    expect(getState("s1").tasks).toHaveLength(0);
  });

  it("serializes two batched todo calls against the same slot", async () => {
    // Pi runs a batch of tool calls concurrently unless the tool opts out; the
    // store's runExclusive queue keeps the read-modify-write cycles ordered
    // even when a host ignores executionMode.
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const ctx = mockCtx("s1");
    const [first, second] = await Promise.all([
      tool.execute("c1", { action: "create", subject: "one" }, undefined, undefined, ctx),
      tool.execute("c2", { action: "create", subject: "two" }, undefined, undefined, ctx),
    ]);
    expect(first.content[0]?.text).toBe("Created #1: one (pending)");
    expect(second.content[0]?.text).toBe("Created #2: two (pending)");
    expect(getState("s1").tasks.map((t) => t.subject)).toEqual(["one", "two"]);
    expect(getState("s1").nextId).toBe(3);
  });
});

describe("renderCall", () => {
  it("shows the create glyph plus the subject", () => {
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const renderCall = must(tool.renderCall, "renderCall missing");
    const text = renderCall({ action: "create", subject: "write tests" }, mockTheme(), {});
    expect(text.render(120).join(" ")).toContain("todo + write tests");
  });

  it("falls back to the raw id when the subject is unknown", () => {
    const pi = makePi();
    registerTodoTool(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const renderCall = must(tool.renderCall, "renderCall missing");
    const text = renderCall({ action: "delete", id: 7 }, mockTheme(), {});
    expect(text.render(120).join(" ")).toContain("#7");
  });
});

describe("extension lifecycle", () => {
  it("registers the tool and the lifecycle handlers", () => {
    const pi = makePi();
    defaultExtension(pi as never);
    expect(pi.tools.map((t) => t.name)).toContain(TOOL_NAME);
    for (const event of ["session_start", "session_compact", "session_tree", "session_shutdown"]) {
      expect(pi.handlers.has(event), `handler for ${event}`).toBe(true);
    }
  });

  it("session_start replays the branch into the session slot", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    const branch = [
      detailsEntry({
        action: "create",
        params: { action: "create", subject: "one" },
        tasks: [{ id: 1, subject: "one", status: "completed" }],
        nextId: 2,
      }),
    ];
    await start(
      { type: "session_start", reason: "startup" } as never,
      mockCtx("s1", branch) as never,
    );
    expect(getState("s1").tasks[0]?.status).toBe("completed");
    expect(getState("s1").nextId).toBe(2);
  });

  it("session_start claims the foreground for the first UI session only", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    await start({ type: "session_start", reason: "startup" } as never, mockCtx("first") as never);
    // The pointer claims "first": commits there surface in the ctx-less render slot.
    commitState("first", { tasks: [{ id: 1, subject: "one", status: "pending" }], nextId: 2 });
    expect(getRenderState().tasks).toHaveLength(1);

    // A child session (distinct sid) must not steal the foreground.
    await start({ type: "session_start", reason: "fork" } as never, mockCtx("child") as never);
    commitState("child", {
      tasks: [
        { id: 1, subject: "a", status: "pending" },
        { id: 2, subject: "b", status: "pending" },
      ],
      nextId: 3,
    });
    expect(getRenderState().tasks).toHaveLength(1);
  });

  it("session_start in headless mode replays but never claims the foreground", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    await start(
      { type: "session_start", reason: "startup" } as never,
      mockCtx("headless", [], false) as never,
    );
    // No UI session claimed the pointer: commits to the headless slot do not
    // surface in the render slot.
    commitState("headless", { tasks: [{ id: 1, subject: "one", status: "pending" }], nextId: 2 });
    expect(getRenderState().tasks).toEqual([]);
  });

  it("session_compact replays the compacted session's slot and refreshes the foreground overlay", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    const compact = must(pi.handlers.get("session_compact"), "handler missing");
    // The first UI session claims the foreground and binds the overlay to
    // its own UI context.
    const startCtx = mockCtx("fg");
    await start({ type: "session_start" } as never, startCtx as never);
    const branch = [
      detailsEntry({
        action: "update",
        params: { action: "update", id: 1, status: "completed" },
        tasks: [{ id: 1, subject: "one", status: "completed" }],
        nextId: 2,
      }),
    ];
    const compactCtx = mockCtx("fg", branch);
    await compact({ type: "session_compact" } as never, compactCtx as never);
    expect(getState("fg").tasks[0]?.status).toBe("completed");
    // The replay replaced the foreground slot's content, so the handler must
    // refresh the overlay; without it the widget shows the old list until
    // the next todo call happens to repaint. The widget lives in the UI
    // context the claim captured, not the compact event's one.
    expect(startCtx.ui.widgets.some((w) => w.key === "pi-todo-agent" && w.factory)).toBe(true);
  });

  it("session_tree replays the same way", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const tree = must(pi.handlers.get("session_tree"), "handler missing");
    const branch = [
      detailsEntry({
        action: "create",
        params: { action: "create", subject: "one" },
        tasks: [{ id: 1, subject: "one", status: "pending" }],
        nextId: 3,
      }),
    ];
    await tree({ type: "session_tree" } as never, mockCtx("s3", branch) as never);
    expect(getState("s3").nextId).toBe(3);
  });

  it("swallows the stale-ctx error after session replacement", () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const compact = must(pi.handlers.get("session_compact"), "handler missing");
    const staleCtx: MockCtx = {
      hasUI: true,
      ui: mockUI(),
      sessionManager: {
        getSessionId: () => {
          throw new Error("sessionManager is stale after session replacement");
        },
        getBranch: () => [],
      },
    };
    expect(() => compact({ type: "session_compact" } as never, staleCtx as never)).not.toThrow();
  });

  it("propagates replay bugs other than the stale-ctx error", () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const compact = must(pi.handlers.get("session_compact"), "handler missing");
    const brokenCtx: MockCtx = {
      hasUI: true,
      ui: mockUI(),
      sessionManager: {
        getSessionId: () => {
          throw new Error("branch iteration failed");
        },
        getBranch: () => [],
      },
    };
    expect(() => compact({ type: "session_compact" } as never, brokenCtx as never)).toThrow(
      "branch iteration failed",
    );
  });

  it("session_shutdown evicts the slot and clears the foreground pointer", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    const shutdown = must(pi.handlers.get("session_shutdown"), "handler missing");
    await start({ type: "session_start", reason: "startup" } as never, mockCtx("fg") as never);
    await shutdown({ type: "session_shutdown" } as never, mockCtx("fg") as never);
    // The slot is gone (fresh empty state) and the pointer no longer
    // resolves to it: a post-shutdown commit stays invisible to the render slot.
    expect(getState("fg").tasks).toEqual([]);
    commitState("fg", { tasks: [{ id: 1, subject: "one", status: "pending" }], nextId: 2 });
    expect(getRenderState().tasks).toEqual([]);
  });

  it("a child session's shutdown leaves the foreground intact", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const start = must(pi.handlers.get("session_start"), "handler missing");
    const shutdown = must(pi.handlers.get("session_shutdown"), "handler missing");
    await start({ type: "session_start", reason: "startup" } as never, mockCtx("fg") as never);
    const child = mockCtx("child");
    await shutdown({ type: "session_shutdown" } as never, child as never);
    expect(getState("child").tasks).toEqual([]);
    // Foreground pointer still resolves to fg's slot: its commits render.
    commitState("fg", { tasks: [{ id: 1, subject: "one", status: "pending" }], nextId: 2 });
    expect(getRenderState().tasks).toHaveLength(1);
  });
});

describe("end-to-end tool flow", () => {
  it("create -> complete produces the all-done summary through the registered tool", async () => {
    const pi = makePi();
    defaultExtension(pi as never);
    const tool = must(pi.tools[0], "tool missing");
    const ctx = mockCtx("flow");
    await tool.execute("c1", { action: "create", subject: "one" }, undefined, undefined, ctx);
    await tool.execute("c2", { action: "create", subject: "two" }, undefined, undefined, ctx);
    const mid = await tool.execute(
      "c3",
      { action: "update", id: 1, status: "completed" },
      undefined,
      undefined,
      ctx,
    );
    expect(mid.content[0]?.text).toBe("Updated #1 (pending → completed)");
    const last = await tool.execute(
      "c4",
      { action: "update", id: 2, status: "completed" },
      undefined,
      undefined,
      ctx,
    );
    expect(last.content[0]?.text).toBe(
      [
        "Updated #2 (pending → completed)",
        "",
        "All 2 tasks done:",
        "  ✓ #1 one",
        "  ✓ #2 two",
      ].join("\n"),
    );
  });
});
