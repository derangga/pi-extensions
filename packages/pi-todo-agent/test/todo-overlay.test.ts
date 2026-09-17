import { beforeEach, describe, expect, it } from "vitest";
import { TodoOverlay, WIDGET_KEY } from "../src/todo-overlay.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { __resetState, commitState, setActiveRenderSession } from "../src/state/store.js";
import type { TaskDetails } from "../src/tool/types.js";

/** Strip ANSI escape sequences so a rendered line's literal length is its display width. */
function stripAnsi(line: string): string {
  // SAFETY: test-only display measurement; ANSI CSI sequences are dropped whole.
  return line.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

interface MockComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface CapturedWidget {
  key: string;
  factory: ((tui: MockTui, theme: Theme) => MockComponent) | undefined;
  options?: { placement?: string } | undefined;
}

interface MockTui {
  renders: Array<{ force: boolean }>;
  requestRender(force?: boolean): void;
}

interface MockUICtx {
  theme: Theme;
  widgets: CapturedWidget[];
  setWidget(key: string, content: unknown, options?: { placement?: string }): void;
  getToolsExpanded?(): boolean;
}

function makeTui(): MockTui {
  const tui: MockTui = {
    renders: [],
    requestRender(force) {
      tui.renders.push({ force: force === true });
    },
  };
  return tui;
}

function makeUICtx(overrides?: Partial<Theme>): MockUICtx {
  const theme: Theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
    ...overrides,
  } as Theme;
  const ui: MockUICtx = {
    theme,
    widgets: [],
    setWidget(key, content, options) {
      const existing = ui.widgets.find((w) => w.key === key);
      if (existing) {
        existing.factory = content as CapturedWidget["factory"];
        existing.options = options;
        return;
      }
      ui.widgets.push({ key, factory: content as CapturedWidget["factory"], options });
    },
  };
  return ui;
}

function renderWidget(ui: MockUICtx, width = 80): string[] {
  const widget = ui.widgets.find((w) => w.key === WIDGET_KEY);
  if (!widget?.factory) {
    throw new Error("widget not registered");
  }
  const tui = makeTui();
  const component = widget.factory(tui, ui.theme);
  return component.render(width);
}

function commitSnapshot(tasks: TaskDetails["tasks"], nextId = tasks.length + 1): void {
  commitState("fg", { tasks, nextId });
}

beforeEach(() => {
  __resetState();
  setActiveRenderSession("fg");
});

describe("registration lifecycle", () => {
  it("registers once and requests render on refresh", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "pending" }]);
    overlay.update();
    expect(ui.widgets).toHaveLength(1);
    overlay.update();
    expect(ui.widgets).toHaveLength(1);
    expect(renderWidget(ui).join("\n")).toContain("Todos");
  });

  it("unregisters when nothing is visible", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "gone", status: "deleted" }]);
    overlay.update();
    const widget = ui.widgets.find((w) => w.key === WIDGET_KEY);
    expect(widget?.factory).toBeUndefined();
  });

  it("re-registers when the UI context identity changes", () => {
    const ui1 = makeUICtx();
    const ui2 = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui1 as never);
    commitSnapshot([{ id: 1, subject: "one", status: "pending" }]);
    overlay.update();
    overlay.setUICtx(ui2 as never);
    overlay.update();
    expect(ui2.widgets).toHaveLength(1);
  });

  it("renders above the editor", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "pending" }]);
    overlay.update();
    expect(ui.widgets[0]?.options?.placement).toBe("aboveEditor");
  });

  it("dispose clears the widget and display state", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "pending" }]);
    overlay.update();
    overlay.dispose();
    const widget = ui.widgets.find((w) => w.key === WIDGET_KEY);
    expect(widget?.factory).toBeUndefined();
    expect(overlay.isRegistered()).toBe(false);
  });
});

describe("rendering", () => {
  it("renders the in_progress subject bold, pending plain", () => {
    // Weight survives themes and color-blind palettes that mute accent.
    const ui = makeUICtx({
      bold: (text) => `<b>${text}</b>`,
      strikethrough: (text) => `<s>${text}</s>`,
    });
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "writing tests", status: "in_progress", activeForm: "testing" },
      { id: 2, subject: "queued", status: "pending" },
    ]);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).toContain("<b>writing tests</b>");
    expect(text).not.toContain("<b>queued</b>");
    expect(text).not.toContain("<b><b>");
  });

  it("renders heading with completion counts and per-task rows", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "research", status: "completed" },
      { id: 2, subject: "implement", status: "in_progress", activeForm: "implementing" },
      { id: 3, subject: "test", status: "pending" },
    ]);
    overlay.update();
    const lines = renderWidget(ui);
    const text = lines.join("\n");
    expect(text).toContain("Todos (1/3)");
    expect(text).toContain("implementing");
    expect(text).toContain("test");
  });

  it("shows the blockedBy chain and task ids when dependencies exist", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "deploy", status: "pending", blockedBy: [2] },
      { id: 2, subject: "build", status: "pending" },
    ]);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).toContain("#1");
    expect(text).toContain("⛓ #2");
  });

  it("hides chain links that point at tombstoned tasks", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "deploy", status: "pending", blockedBy: [2] },
      { id: 2, subject: "gone", status: "deleted" },
    ]);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).not.toContain("⛓");
    // The dangling chain was the only one: ids hide again too.
    expect(text).not.toContain("#1");
  });

  it("hides ids when no task carries dependencies", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "simple", status: "pending" }]);
    overlay.update();
    expect(renderWidget(ui).join("\n")).not.toContain("#1");
  });

  it("appends a trailing spacer row", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "pending" }]);
    overlay.update();
    const lines = renderWidget(ui);
    expect(lines[lines.length - 1]).toBe("");
  });

  it("truncates to the fixed budget with a +N more summary", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      subject: `task ${i + 1}`,
      status: "pending" as const,
    }));
    commitSnapshot(tasks);
    overlay.update();
    const lines = renderWidget(ui);
    // Budget 12 content rows: heading + 10 task rows + summary + spacer.
    const text = lines.join("\n");
    expect(text).toContain("+");
    expect(text).toContain("more");
    // The dropped tail is genuinely absent.
    expect(text).not.toContain("task 20");
  });

  it("drops completed rows first when over budget", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        subject: `done ${i + 1}`,
        status: "completed" as const,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 9 + i,
        subject: `open ${i + 1}`,
        status: "pending" as const,
      })),
    ];
    commitSnapshot(tasks);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).toContain("completed");
    // All open tasks survive; completed ones make room.
    expect(text).toContain("open 6");
    expect(text).not.toContain("done 8");
  });

  it("expands fully when tool output is expanded", () => {
    const ui = makeUICtx();
    ui.getToolsExpanded = () => true;
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      subject: `task ${i + 1}`,
      status: "pending" as const,
    }));
    commitSnapshot(tasks);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).toContain("task 20");
  });

  it("truncates long subjects to the terminal width", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "x".repeat(200), status: "pending" }]);
    overlay.update();
    const lines = renderWidget(ui, 40);
    // truncateToWidth keeps visual width but emits ANSI reset codes around
    // the ellipsis; measure display width after stripping them.
    for (const line of lines) {
      const visible = stripAnsi(line);
      expect(visible.length).toBeLessThanOrEqual(40);
    }
  });
});

// Every scenario here keeps an "anchor" task pending throughout, so the list
// is never all-complete and the fade path is exercised independently of the
// all-complete flush gate covered in the next describe block.
describe("completed fade-out", () => {
  it("hides completed tasks from previous turns at agent_start", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "done", status: "completed" },
      { id: 2, subject: "anchor", status: "pending" },
    ]);
    overlay.update();
    expect(renderWidget(ui).join("\n")).toContain("done");

    overlay.hideCompletedTasksFromPreviousTurn();
    const text = renderWidget(ui).join("\n");
    expect(text).not.toContain("done");
    // The anchor is still pending, so the widget stays up.
    expect(text).toContain("anchor");
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeDefined();
  });

  it("keeps completed tasks visible within the current turn, then fades them", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    const anchor = { id: 99, subject: "anchor", status: "pending" as const };

    // Turn 1: task 1 completed and rendered. The host renders after every
    // refresh; that render pass is what queues the row for fade-out.
    commitSnapshot([{ id: 1, subject: "older", status: "completed" }, anchor]);
    overlay.update();
    renderWidget(ui);
    // Turn 2 starts: task 1 fades out.
    overlay.hideCompletedTasksFromPreviousTurn();

    // Turn 2: task 2 completes and renders alongside the (hidden) task 1.
    commitSnapshot([
      { id: 1, subject: "older", status: "completed" },
      { id: 2, subject: "fresh", status: "completed" },
      anchor,
    ]);
    overlay.update();
    // The host renders after the refresh; the render pass is what tracks
    // which completed rows are pending fade-out.
    const text = renderWidget(ui).join("\n");
    expect(text).not.toContain("older");
    expect(text).toContain("fresh");

    // Turn 3 starts: task 2 fades out too. The anchor is still pending, so
    // the widget stays up showing only the anchor.
    overlay.hideCompletedTasksFromPreviousTurn();
    overlay.update();
    const finalText = renderWidget(ui).join("\n");
    expect(finalText).not.toContain("fresh");
    expect(finalText).toContain("anchor");
  });

  it("forgets hidden ids after a clear (reborn task at a reused id)", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    const anchor = { id: 99, subject: "anchor", status: "pending" as const };
    // Turn 1: task 1 completes and fades at the next turn boundary.
    commitSnapshot([{ id: 1, subject: "done", status: "completed" }, anchor]);
    overlay.update();
    overlay.hideCompletedTasksFromPreviousTurn();
    // The list is cleared and rebuilt: id 1 is a different task now at the
    // same counter position. The stale hidden entry must not suppress it.
    commitSnapshot([{ id: 1, subject: "reborn", status: "completed" }, anchor]);
    overlay.update();
    expect(renderWidget(ui).join("\n")).toContain("reborn");
    // And it fades again at the next turn boundary.
    overlay.hideCompletedTasksFromPreviousTurn();
    overlay.update();
    expect(renderWidget(ui).join("\n")).not.toContain("reborn");
  });

  it("keeps a completed task visible until the next turn even if nothing rendered", () => {
    // Fade detection reads the live state at agent_start, not the render
    // history: a completion that never painted still fades exactly once, at
    // the next turn boundary.
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "done", status: "completed" },
      { id: 2, subject: "anchor", status: "pending" },
    ]);
    overlay.update();
    // No render in between: the old render-time detection missed this case.
    expect(renderWidget(ui).join("\n")).toContain("done");
    overlay.hideCompletedTasksFromPreviousTurn();
    overlay.update();
    expect(renderWidget(ui).join("\n")).not.toContain("done");
  });
});

describe("all-complete flush gate", () => {
  it("never registers the widget once every visible task is completed", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "one", status: "completed" },
      { id: 2, subject: "two", status: "completed" },
    ]);
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeUndefined();
  });

  it("unregisters an already-mounted widget the instant the list completes", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "in_progress" }]);
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeDefined();

    commitSnapshot([{ id: 1, subject: "one", status: "completed" }]);
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeUndefined();
  });

  it("still renders a mixed list where some tasks are completed", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([
      { id: 1, subject: "done", status: "completed" },
      { id: 2, subject: "open", status: "pending" },
    ]);
    overlay.update();
    const text = renderWidget(ui).join("\n");
    expect(text).toContain("done");
    expect(text).toContain("open");
  });

  it("never re-registers on replay into an all-complete state", () => {
    // Simulates the effect of index.ts's replaySessionSlot on /reload: the
    // store is replaced directly (no overlay.update() in between), then the
    // overlay's next update() must still refuse to show it.
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "one", status: "completed" }]);
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeUndefined();
  });
});
