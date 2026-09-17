import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { appendCompletedTodos, ENTRY_TYPE, registerTodoEntryRenderer } from "../src/todo-entry.js";
import type { Task } from "../src/tool/types.js";

interface MockCustomEntry {
  type: "custom";
  customType: string;
  data: { tasks: Task[] } | undefined;
}

type EntryRenderer = (
  entry: MockCustomEntry,
  options: { expanded: boolean },
  theme: Theme,
) => { render(width: number): string[] } | undefined;

interface MockPi {
  entryRenderers: Map<string, EntryRenderer>;
  appendedEntries: Array<{ customType: string; data: unknown }>;
  registerEntryRenderer(customType: string, renderer: EntryRenderer): void;
  appendEntry(customType: string, data: unknown): void;
}

function makePi(): MockPi {
  const pi: MockPi = {
    entryRenderers: new Map(),
    appendedEntries: [],
    registerEntryRenderer(customType, renderer) {
      pi.entryRenderers.set(customType, renderer);
    },
    appendEntry(customType, data) {
      pi.appendedEntries.push({ customType, data });
    },
  };
  return pi;
}

function mockTheme(overrides?: Partial<Theme>): Theme {
  return {
    fg: (_color, text) => text,
    bold: (text) => `<b>${text}</b>`,
    strikethrough: (text) => `<s>${text}</s>`,
    ...overrides,
  } as Theme;
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe("registerTodoEntryRenderer", () => {
  it("registers under the namespaced entry type", () => {
    const pi = makePi();
    registerTodoEntryRenderer(pi as never);
    expect(pi.entryRenderers.has(ENTRY_TYPE)).toBe(true);
  });
});

describe("appendCompletedTodos", () => {
  it("appends a snapshot of the tasks under the namespaced entry type", () => {
    const pi = makePi();
    const tasks: Task[] = [{ id: 1, subject: "one", status: "completed" }];
    appendCompletedTodos(pi as never, tasks);
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0]?.customType).toBe(ENTRY_TYPE);
    expect(pi.appendedEntries[0]?.data).toEqual({ tasks });
  });

  it("snapshots the array so a later mutation of the source doesn't alias it", () => {
    const pi = makePi();
    const tasks: Task[] = [{ id: 1, subject: "one", status: "completed" }];
    appendCompletedTodos(pi as never, tasks);
    tasks.push({ id: 2, subject: "two", status: "completed" });
    const data = pi.appendedEntries[0]?.data as { tasks: Task[] };
    expect(data.tasks).toHaveLength(1);
  });
});

describe("rendering", () => {
  function render(tasks: Task[], theme = mockTheme()): string {
    const pi = makePi();
    registerTodoEntryRenderer(pi as never);
    const renderer = must(pi.entryRenderers.get(ENTRY_TYPE), "renderer missing");
    const component = must(
      renderer(
        { type: "custom", customType: ENTRY_TYPE, data: { tasks } },
        { expanded: false },
        theme,
      ),
      "component missing",
    );
    return component.render(80).join("\n");
  }

  it("rebuilds purely from entry.data — the renderer never touches the store", () => {
    const text = render([{ id: 1, subject: "write tests", status: "completed" }]);
    expect(text).toContain("write tests");
    expect(text).toContain("Todos (1/1)");
  });

  it("strikes through completed subjects", () => {
    const text = render([{ id: 1, subject: "done thing", status: "completed" }]);
    expect(text).toContain("<s>");
    expect(text).toContain("done thing");
  });

  it("renders the heading with the completed/total count", () => {
    const text = render([
      { id: 1, subject: "a", status: "completed" },
      { id: 2, subject: "b", status: "completed" },
      { id: 3, subject: "c", status: "completed" },
    ]);
    expect(text).toContain("Todos (3/3)");
  });

  it("renders every row for a long list — no widget-style truncation", () => {
    const tasks: Task[] = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      subject: `task ${i + 1}`,
      status: "completed" as const,
    }));
    const text = render(tasks);
    for (const t of tasks) {
      expect(text).toContain(t.subject);
    }
    expect(text).not.toContain("more");
  });

  it("drops tombstones from the block", () => {
    const text = render([
      { id: 1, subject: "kept", status: "completed" },
      { id: 2, subject: "gone", status: "deleted" },
    ]);
    expect(text).toContain("kept");
    expect(text).not.toContain("gone");
  });

  it("tolerates missing entry data", () => {
    const pi = makePi();
    registerTodoEntryRenderer(pi as never);
    const renderer = must(pi.entryRenderers.get(ENTRY_TYPE), "renderer missing");
    const component = must(
      renderer(
        { type: "custom", customType: ENTRY_TYPE, data: undefined },
        { expanded: false },
        mockTheme(),
      ),
      "component missing",
    );
    expect(() => component.render(80)).not.toThrow();
  });
});
