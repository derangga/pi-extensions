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

describe("completed fade-out", () => {
  it("hides completed tasks from previous turns at agent_start", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "done", status: "completed" }]);
    overlay.update();
    expect(renderWidget(ui).join("\n")).toContain("done");

    overlay.hideCompletedTasksFromPreviousTurn();
    expect(renderWidget(ui).join("\n")).not.toContain("done");
    // Everything hidden means the widget unregisters.
    overlay.update();
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeUndefined();
  });

  it("keeps completed tasks visible within the current turn, then fades them", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);

    // Turn 1: task 1 completed and rendered. The host renders after every
    // refresh; that render pass is what queues the row for fade-out.
    commitSnapshot([{ id: 1, subject: "older", status: "completed" }]);
    overlay.update();
    renderWidget(ui);
    // Turn 2 starts: task 1 fades out.
    overlay.hideCompletedTasksFromPreviousTurn();

    // Turn 2: task 2 completes and renders alongside the (hidden) task 1.
    commitSnapshot([
      { id: 1, subject: "older", status: "completed" },
      { id: 2, subject: "fresh", status: "completed" },
    ]);
    overlay.update();
    // The host renders after the refresh; the render pass is what tracks
    // which completed rows are pending fade-out.
    const text = renderWidget(ui).join("\n");
    expect(text).not.toContain("older");
    expect(text).toContain("fresh");

    // Turn 3 starts: task 2 fades out too, and the widget auto-hides.
    overlay.hideCompletedTasksFromPreviousTurn();
    overlay.update();
    // Nothing visible means the widget unregisters.
    expect(ui.widgets.find((w) => w.key === WIDGET_KEY)?.factory).toBeUndefined();
  });

  it("forgets hidden ids after a clear (nextId reset)", () => {
    const ui = makeUICtx();
    const overlay = new TodoOverlay();
    overlay.setUICtx(ui as never);
    commitSnapshot([{ id: 1, subject: "done", status: "completed" }]);
    overlay.update();
    overlay.hideCompletedTasksFromPreviousTurn();
    // A new list starts over: id 1 is a different task now.
    commitSnapshot([{ id: 1, subject: "reborn", status: "completed" }]);
    overlay.update();
    overlay.hideCompletedTasksFromPreviousTurn();
    commitSnapshot([{ id: 1, subject: "reborn", status: "completed" }]);
    overlay.update();
    expect(renderWidget(ui).join("\n")).toContain("reborn");
  });
});
