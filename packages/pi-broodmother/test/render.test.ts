import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
  callLines,
  createWidgetHost,
  createWidgetRuns,
  formatCost,
  formatElapsed,
  formatTokens,
  resultLines,
  SubagentWidget,
  WIDGET_KEY,
  WIDGET_MAX_LINES,
  widgetLines,
} from "../src/render.js";
import type { RunView, TaskView } from "../src/run.js";

/** Identity colours, so an assertion reads the text and not an escape code. */
// SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const NOW = 60_000;

function taskView(fields: Partial<TaskView> = {}): TaskView {
  return {
    id: "a",
    index: 0,
    wave: 0,
    agent: "reader",
    task: "read the code",
    needs: [],
    model: "anthropic/claude-opus-5",
    thinking: "off",
    status: "running",
    outcome: undefined,
    output: undefined,
    sessionFile: undefined,
    turns: 1,
    toolCalls: 3,
    tokens: 1500,
    billedTokens: 9500,
    cost: 0.0123,
    activity: "Grep useEffect",
    startedAt: NOW - 12_000,
    endedAt: undefined,
    missing: [],
    notes: [],
    ...fields,
  };
}

function runView(tasks: readonly TaskView[], fields: Partial<RunView> = {}): RunView {
  return { id: "run_1", startedAt: 0, finished: false, cancelled: false, tasks, ...fields };
}

const settled = (fields: Partial<TaskView> = {}) =>
  taskView({
    status: "settled",
    outcome: "completed",
    output: "the answer",
    sessionFile: "/sessions/a.jsonl",
    endedAt: NOW - 2_000,
    ...fields,
  });

describe("formatting", () => {
  it("shortens token counts without losing the scale", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(128_400)).toBe("128k");
  });

  it("prints nothing for a cost that was never measured", () => {
    // Zero is not a measurement: a model Pi has no rates for contributes
    // nothing, and $0.0000 would claim the run was measured and found free.
    expect(formatCost(0)).toBeUndefined();
    expect(formatCost(Number.NaN)).toBeUndefined();
    expect(formatCost(-1)).toBeUndefined();
  });

  it("says a real cost is small rather than rounding it to nothing", () => {
    expect(formatCost(0.000_02)).toBe("<$0.0001");
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(1.5)).toBe("$1.5000");
  });

  it("leaves the cost out of a line when there is none", () => {
    const [, line] = widgetLines([runView([taskView({ cost: 0 })])], theme, NOW);
    expect(line).toContain("1.5k tok · 12s");
    expect(line).not.toContain("$");
  });

  it("counts elapsed to the end of a finished task and to now for a live one", () => {
    expect(formatElapsed(taskView(), NOW)).toBe("12s");
    expect(formatElapsed(taskView({ startedAt: NOW - 95_000 }), NOW)).toBe("1m35s");
    expect(formatElapsed(settled({ startedAt: NOW - 30_000 }), NOW)).toBe("28s");
    expect(formatElapsed(taskView({ startedAt: undefined }), NOW)).toBe("–");
  });
});

describe("widgetLines", () => {
  it("renders nothing when no run has tasks", () => {
    expect(widgetLines([], theme, NOW)).toEqual([]);
    expect(widgetLines([runView([])], theme, NOW)).toEqual([]);
  });

  it("puts the count in the header and one line per task", () => {
    const lines = widgetLines([runView([settled(), taskView({ id: "b" })])], theme, NOW);
    expect(lines[0]).toContain("Subagents (1/2)");
    expect(lines).toHaveLength(3);
  });

  it("shows what a running child is doing, and drops it once settled", () => {
    const [, running] = widgetLines([runView([taskView()])], theme, NOW);
    expect(running).toContain("→ Grep useEffect");
    expect(running).toContain("3 tools · 1.5k tok · $0.0123 · 12s");

    const [, done] = widgetLines([runView([settled()])], theme, NOW);
    expect(done).not.toContain("→ Grep useEffect");
  });

  it("says what a pending task is waiting for", () => {
    const [, pending] = widgetLines(
      [runView([taskView({ status: "pending", needs: ["up"], startedAt: undefined })])],
      theme,
      NOW,
    );
    expect(pending).toContain("↳ waits up");
  });

  it("keeps the running tasks when there is not room for all of them", () => {
    const tasks = [
      ...Array.from({ length: WIDGET_MAX_LINES }, (_, index) =>
        settled({ id: `done_${index}`, agent: `finished_${index}` }),
      ),
      taskView({ id: "live", agent: "still_working" }),
    ];
    const lines = widgetLines([runView(tasks)], theme, NOW);

    expect(lines).toHaveLength(WIDGET_MAX_LINES);
    expect(lines[1]).toContain("still_working");
    expect(lines[lines.length - 1]).toContain("more");
  });
});

describe("SubagentWidget", () => {
  it("truncates to the terminal width", () => {
    const widget = new SubagentWidget(
      () => [runView([taskView()])],
      theme,
      () => NOW,
    );
    // Measured, not counted: truncateToWidth leaves reset escapes behind, so
    // the string is longer than the columns it occupies.
    for (const line of widget.render(30)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("reads the snapshot on every render rather than caching it", () => {
    let runs: RunView[] = [runView([taskView()])];
    const widget = new SubagentWidget(
      () => runs,
      theme,
      () => NOW,
    );
    expect(widget.render(200)[0]).toContain("(0/1)");
    runs = [runView([settled()])];
    expect(widget.render(200)[0]).toContain("(1/1)");
  });
});

describe("createWidgetHost", () => {
  function fakeContext() {
    const tui = { requestRender: vi.fn<() => void>() };
    const setWidget = vi.fn<(key: string, content: unknown) => void>((_key, content) => {
      if (typeof content === "function") {
        // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
        (content as (tui: unknown, theme: Theme) => unknown)(tui, theme);
      }
    });
    return {
      tui,
      setWidget,
      // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
      ctx: { hasUI: true, ui: { setWidget } } as unknown as ExtensionContext,
    };
  }

  it("mounts once however many changes arrive", () => {
    vi.useFakeTimers();
    const { ctx, setWidget, tui } = fakeContext();
    const host = createWidgetHost(() => [], 150);

    for (let index = 0; index < 20; index++) {
      host.update(ctx);
    }
    expect(setWidget).toHaveBeenCalledTimes(1);

    // Twenty changes inside one window are one repaint. That is the whole
    // point: a child streaming tokens must not drive the terminal.
    vi.advanceTimersByTime(150);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    host.update(ctx);
    vi.advanceTimersByTime(150);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does nothing without a UI", () => {
    const setWidget = vi.fn<() => void>();
    const host = createWidgetHost(() => []);
    host.update(undefined);
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    host.update({ hasUI: false, ui: { setWidget } } as unknown as ExtensionContext);
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("removes the widget on clear and survives a torn-down TUI", () => {
    const { ctx, setWidget } = fakeContext();
    const host = createWidgetHost(() => [], 150);
    host.update(ctx);
    host.clear(ctx);
    expect(setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);

    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const throwing = {
      hasUI: true,
      ui: {
        setWidget: () => {
          throw new Error("tui is gone");
        },
      },
    } as unknown as ExtensionContext;
    const second = createWidgetHost(() => [], 150);
    second.update(throwing);
    expect(() => second.clear(throwing)).not.toThrow();
  });
});

describe("callLines", () => {
  it("says preparing while the arguments are still empty", () => {
    expect(callLines(undefined, theme)[0]).toContain("preparing…");
    expect(callLines({}, theme)[0]).toContain("preparing…");
  });

  it("survives half-typed tasks with missing and wrong-typed fields", () => {
    const lines = callLines(
      { tasks: [{ agent: "reader" }, {}, { id: 7, task: 12 }, "nonsense"] },
      theme,
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("task_1 reader");
    expect(lines[2]).toContain("task_2 …");
    expect(lines[3]).toContain("task_3 …");
  });

  it("calls a batch parallel until a task declares an edge", () => {
    expect(callLines({ tasks: [{ agent: "a" }, { agent: "b" }] }, theme)[0]).toContain(
      "parallel 2",
    );
    const graph = callLines(
      {
        tasks: [
          { id: "up", agent: "a" },
          { id: "down", agent: "b", needs: ["up"] },
        ],
      },
      theme,
    );
    expect(graph[0]).toContain("graph 2");
    expect(graph[2]).toContain("← up");
  });

  it("marks whether the call will block", () => {
    expect(callLines({ tasks: [{ agent: "a" }] }, theme)[0]).toContain("[background]");
    expect(callLines({ tasks: [{ agent: "a" }], autoAwait: true }, theme)[0]).toContain("[await]");
  });

  it("flattens and truncates a long goal to one line", () => {
    const goal = `${"x".repeat(80)}\n  and more`;
    const line = callLines({ tasks: [{ agent: "a", task: goal }] }, theme)[1]!;
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(120);
  });
});

describe("resultLines", () => {
  it("collapses to one summary line", () => {
    const lines = resultLines(
      runView([settled(), settled({ id: "b" })], { finished: true }),
      theme,
      false,
    );
    expect(lines).toEqual(["2/2 done settled · 3.0k tok · $0.0246"]);
  });

  it("counts what did not finish cleanly", () => {
    const lines = resultLines(
      runView([settled(), settled({ id: "b", outcome: "timed_out" })], { finished: true }),
      theme,
      false,
    );
    expect(lines[0]).toContain("1 not clean");
  });

  it("expands to per-task rows carrying output and the transcript path", () => {
    const lines = resultLines(runView([settled()], { finished: true }), theme, true, NOW);
    expect(lines.join("\n")).toContain("the answer");
    expect(lines.join("\n")).toContain("/sessions/a.jsonl");
  });

  it("says why a skipped task has nothing to show", () => {
    const lines = resultLines(
      runView([taskView({ status: "skipped", missing: ["up"], endedAt: NOW })], { finished: true }),
      theme,
      true,
      NOW,
    );
    expect(lines.join("\n")).toContain("skipped: up produced nothing");
  });
});

describe("createWidgetRuns", () => {
  const done = (id: string) => runView([settled()], { id, finished: true });
  const live = (id: string) => runView([taskView()], { id, finished: false });

  it("draws what the manager pushes", () => {
    const drawn = createWidgetRuns();
    drawn.replace([done("run_1")]);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_1"]);
  });

  it("keeps a settled run on screen for the rest of its turn", () => {
    const drawn = createWidgetRuns();
    drawn.replace([done("run_1")]);
    // No agent_settled yet, so this agent_start is the same turn resuming
    // after a retry or an auto-compaction.
    expect(drawn.beginTurn()).toBe(false);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_1"]);
  });

  it("stops drawing a settled run once the next turn begins", () => {
    const drawn = createWidgetRuns();
    drawn.replace([done("run_1")]);
    drawn.endTurn();

    expect(drawn.beginTurn()).toBe(true);
    expect(drawn.current()).toEqual([]);
  });

  it("does not let a dropped run come back on the next snapshot", () => {
    // The manager holds every run for the session and pushes all of them, so
    // dropping one has to be remembered or it returns on the next repaint.
    const drawn = createWidgetRuns();
    drawn.replace([done("run_1")]);
    drawn.endTurn();
    drawn.beginTurn();

    drawn.replace([done("run_1"), live("run_2")]);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_2"]);
  });

  it("keeps a run that is still working, however many turns it takes", () => {
    const drawn = createWidgetRuns();
    drawn.replace([live("run_1")]);
    drawn.endTurn();

    expect(drawn.beginTurn()).toBe(false);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_1"]);
  });

  it("drops the settled run and keeps the live one", () => {
    const drawn = createWidgetRuns();
    drawn.replace([live("run_1"), done("run_2")]);
    drawn.endTurn();

    expect(drawn.beginTurn()).toBe(true);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_1"]);
  });

  it("needs a turn to end before each clear, not just the first", () => {
    const drawn = createWidgetRuns();
    drawn.replace([done("run_1")]);
    drawn.endTurn();
    drawn.beginTurn();

    drawn.replace([done("run_1"), done("run_2")]);
    expect(drawn.beginTurn()).toBe(false);
    expect(drawn.current().map((run) => run.id)).toEqual(["run_2"]);

    drawn.endTurn();
    expect(drawn.beginTurn()).toBe(true);
    expect(drawn.current()).toEqual([]);
  });
});
