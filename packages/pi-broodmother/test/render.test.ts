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
const rawTheme: unknown = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const theme = rawTheme as Theme;

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
    prompt: undefined,
    waiting: undefined,
    outcome: undefined,
    output: undefined,
    sessionFile: undefined,
    turns: 1,
    toolCalls: 3,
    tokens: 1500,
    billedTokens: 9500,
    cost: 0.0123,
    activity: "Grep useEffect",
    lastActivityAt: undefined,
    startedAt: NOW - 12_000,
    endedAt: undefined,
    missing: [],
    notes: [],
    ...fields,
  };
}

function runView(tasks: readonly TaskView[], fields: Partial<RunView> = {}): RunView {
  return {
    id: "run_1",
    startedAt: 0,
    finished: false,
    cancelled: false,
    permissions: "read-only",
    tasks,
    ...fields,
  };
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

  it("shows that a child is blocked on a question, and for how long", () => {
    const [, blocked] = widgetLines(
      [runView([taskView({ waiting: { question: "which schema?", since: NOW - 521_000 } })])],
      theme,
      NOW,
    );
    expect(blocked).toContain("⏸");
    expect(blocked).toContain("asks · 8m41s");
    // The ask takes the activity slot: a blocked child has no current call.
    expect(blocked).not.toContain("→ Grep useEffect");
    // The question itself belongs to the expanded result row, not this line.
    expect(blocked).not.toContain("which schema?");
    expect(blocked).toContain("3 tools · 1.5k tok");
  });

  it("stops showing an ask once the task is done", () => {
    const [, done] = widgetLines(
      [runView([settled({ waiting: { question: "which schema?", since: NOW - 5_000 } })])],
      theme,
      NOW,
    );
    expect(done).not.toContain("⏸");
    expect(done).not.toContain("asks");
    expect(done).toContain("✓");
  });

  it("stays silent about a child that is working normally", () => {
    // Every tool call, token and message resets the clock, so during ordinary
    // work this number sits near zero. Printing it would be noise on every row.
    const [, busy] = widgetLines(
      [runView([taskView({ lastActivityAt: NOW - 4_000 })])],
      theme,
      NOW,
    );
    expect(busy).not.toContain("quiet");
    expect(busy).toContain("→ Grep useEffect");
  });

  it("says how long a child has been quiet, beside what it went quiet on", () => {
    const [, hushed] = widgetLines(
      [runView([taskView({ lastActivityAt: NOW - 192_000 })])],
      theme,
      NOW,
    );
    expect(hushed).toContain("quiet 3m12s");
    // Beside the activity, not instead of it: the tool it stalled on is the
    // most useful thing on the line.
    expect(hushed).toContain("→ Grep useEffect");
    // Ahead of the stats, so a narrow terminal eats the numbers first.
    expect(hushed).toMatch(/quiet 3m12s.*3 tools/);
  });

  it("counts from the start for a child that has never said anything", () => {
    // A child silent since dispatch is the case most worth surfacing, so an
    // absent timestamp must not read as "no news is good news".
    const [, mute] = widgetLines(
      [runView([taskView({ lastActivityAt: undefined, startedAt: NOW - 61_000 })])],
      theme,
      NOW,
    );
    expect(mute).toContain("quiet 1m1s");
  });

  it("leaves a blocked child to its own elapsed", () => {
    // A blocked child is silent by any definition, but the ask already says how
    // long and names the reason. Two durations would just invite comparison.
    const [, blocked] = widgetLines(
      [
        runView([
          taskView({
            waiting: { question: "which schema?", since: NOW - 521_000 },
            lastActivityAt: NOW - 521_000,
          }),
        ]),
      ],
      theme,
      NOW,
    );
    expect(blocked).toContain("asks · 8m41s");
    expect(blocked).not.toContain("quiet");
  });

  it("says nothing about a task that has not started or has finished", () => {
    const [, pending] = widgetLines(
      [runView([taskView({ status: "pending", needs: ["up"], startedAt: undefined })])],
      theme,
      NOW,
    );
    expect(pending).not.toContain("quiet");

    const [, done] = widgetLines(
      [runView([settled({ lastActivityAt: NOW - 600_000 })])],
      theme,
      NOW,
    );
    expect(done).not.toContain("quiet");
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
    const rawCtx: unknown = { hasUI: true, ui: { setWidget } };
    return {
      tui,
      setWidget,
      // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
      ctx: rawCtx as ExtensionContext,
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
    const rawCtx2: unknown = { hasUI: false, ui: { setWidget } };
    host.update(rawCtx2 as ExtensionContext);
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("removes the widget on clear and survives a torn-down TUI", () => {
    const { ctx, setWidget } = fakeContext();
    const host = createWidgetHost(() => [], 150);
    host.update(ctx);
    host.clear(ctx);
    expect(setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);

    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const rawThrowing: unknown = {
      hasUI: true,
      ui: {
        setWidget: () => {
          throw new Error("tui is gone");
        },
      },
    };
    const throwing = rawThrowing as ExtensionContext;
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

  it("keeps every line of the prompt when expanded, beside the label", () => {
    const prompt = "first line\nsecond line\nthird line";
    const lines = callLines(
      { tasks: [{ id: "one", agent: "a", task: "read code", prompt }] },
      theme,
      true,
    );
    expect(lines).toHaveLength(5);
    // The row keeps the short label in both modes; only the block is new.
    expect(lines[1]).toContain("one a");
    expect(lines[1]).toContain("read code");
    expect(lines[1]).not.toContain("first line");
    expect(lines[2]).toContain("first line");
    expect(lines[3]).toContain("second line");
    expect(lines[4]).toContain("third line");
  });

  it("never expands the label, which is three words and not the prompt", () => {
    const lines = callLines(
      { tasks: [{ agent: "a", task: "read code", prompt: "the real instruction" }] },
      theme,
      true,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("the real instruction");
    expect(lines[2]).not.toContain("read code");
  });

  it("does not truncate a long single-line prompt when expanded", () => {
    const prompt = "y".repeat(200);
    const lines = callLines({ tasks: [{ agent: "a", prompt }] }, theme, true);
    expect(lines[2]).toContain(prompt);
    expect(lines[2]).not.toContain("…");
  });

  it("caps the expanded prompt and says how many lines it dropped", () => {
    const prompt = Array.from({ length: 26 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = callLines({ tasks: [{ agent: "a", prompt }] }, theme, true);
    // header, task, 20 prompt lines, pointer
    expect(lines).toHaveLength(23);
    expect(lines[21]).toContain("line 20");
    expect(lines[22]).toContain("+6 lines");
    expect(lines[22]).not.toContain("line 21");
  });

  it("says one line rather than 1 lines", () => {
    const prompt = Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = callLines({ tasks: [{ agent: "a", prompt }] }, theme, true);
    expect(lines.at(-1)).toContain("+1 line");
    expect(lines.at(-1)).not.toContain("+1 lines");
  });

  it("expands nothing for a task whose prompt is missing or not a string", () => {
    const lines = callLines({ tasks: [{ agent: "a" }, { agent: "b", prompt: 12 }] }, theme, true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("task_1 a");
    expect(lines[2]).toContain("task_2 b");
  });

  it("drops blank trailing lines rather than spending the cap on them", () => {
    const lines = callLines({ tasks: [{ agent: "a", prompt: "only line\n\n  \n" }] }, theme, true);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("only line");
  });
});

describe("resultLines", () => {
  it("collapses to one summary line", () => {
    const lines = resultLines(
      runView([settled(), settled({ id: "b" })], { finished: true }),
      theme,
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2/2 done settled · 3.0k tok · $0.0246");
    expect(lines[0]).toContain("ctrl+o to expand");
  });

  it("counts what did not finish cleanly", () => {
    const lines = resultLines(
      runView([settled(), settled({ id: "b", outcome: "timed_out" })], { finished: true }),
      theme,
      false,
    );
    expect(lines[0]).toContain("1 not clean");
  });

  it("keeps a multi-line answer on multiple lines", () => {
    // It used to run through `text`, which flattens every newline, and then a
    // 120 character cut: 24k retained, one squashed line readable. Reading a
    // prompt against the answer it produced is why this row expands at all.
    const answer = ["## Findings", "", "1. The first thing", "2. The second thing"].join("\n");
    const lines = resultLines(
      runView([settled({ output: answer })], { finished: true }),
      theme,
      true,
      NOW,
    );
    const text = lines.join("\n");
    expect(text).toContain("output:");
    expect(text).toContain("## Findings");
    expect(text).toContain("2. The second thing");
    // Four separate rows, not one joined line.
    expect(lines.filter((line) => line.includes("The first thing"))).toHaveLength(1);
    expect(text).not.toContain("## Findings 1. The first thing");
  });

  it("caps a long answer and says how much it held back", () => {
    const answer = Array.from({ length: 26 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = resultLines(
      runView([settled({ output: answer })], { finished: true }),
      theme,
      true,
      NOW,
    );
    const text = lines.join("\n");
    expect(text).toContain("line 20");
    expect(text).not.toContain("line 21");
    expect(text).toContain("… +6 lines");
  });

  it("prints no output block for a task that produced nothing", () => {
    const lines = resultLines(
      runView([settled({ output: undefined })], { finished: true }),
      theme,
      true,
      NOW,
    );
    expect(lines.join("\n")).not.toContain("output:");
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

  it("prints the prompt the child was sent, not the template", () => {
    const lines = resultLines(
      runView(
        [settled({ task: "Review {previous}", prompt: "Review\n## up\nthe upstream text" })],
        {
          finished: true,
        },
      ),
      theme,
      true,
      NOW,
    );
    const body = lines.join("\n");
    expect(body).toContain("prompt:");
    expect(body).toContain("## up");
    expect(body).toContain("the upstream text");
    expect(body).not.toContain("{previous}");
  });

  it("caps the prompt it prints and points at what it kept back", () => {
    const prompt = Array.from({ length: 23 }, (_, index) => `line ${index + 1}`).join("\n");
    const body = resultLines(
      runView([settled({ prompt })], { finished: true }),
      theme,
      true,
      NOW,
    ).join("\n");
    expect(body).toContain("line 20");
    expect(body).not.toContain("line 21");
    expect(body).toContain("+3 lines");
  });

  it("omits the prompt block for a task that never dispatched", () => {
    const body = resultLines(
      runView([taskView({ status: "skipped", missing: ["up"], endedAt: NOW })], { finished: true }),
      theme,
      true,
      NOW,
    ).join("\n");
    expect(body).not.toContain("prompt:");
  });

  it("keeps the prompt out of the collapsed summary", () => {
    const lines = resultLines(
      runView([settled({ prompt: "the whole prompt" })], { finished: true }),
      theme,
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("the whole prompt");
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
