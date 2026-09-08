import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Predicate } from "effect";

import type { AskWaiting } from "./intercom.js";
import { aggregateUsage, type RunView, type TaskStatus, type TaskView } from "./run.js";
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Roughly one render per 150ms. A child streaming tokens fires the change hook
 * far faster than a terminal can usefully repaint.
 */
export const WIDGET_THROTTLE_MS = 150;
export const WIDGET_KEY = "pi-broodmother";
/** Header plus tasks. Past this the widget is eating the transcript. */
export const WIDGET_MAX_LINES = 9;
const GOAL_MAX = 64;
/**
 * How long a child must show no sign of life before the widget says so. Not a
 * verdict that anything is wrong: a command that writes nothing until it exits
 * is silent and healthy. It is a floor on rendering, because every tool call,
 * token and message resets the clock, so during ordinary work this number sits
 * near zero and printing it would be noise on every line.
 */
const QUIET_AFTER_MS = 30_000;
/**
 * How much of a prompt the expanded call row prints. Per task, not per call: a
 * shared budget would give a wide run two lines each, which is the truncation
 * this exists to escape. A chained prompt carries its upstream output, so the
 * cap is what keeps one edge from filling the screen.
 */
const PROMPT_MAX_LINES = 20;

/**
 * Pi's Component is a synchronous `render(width)` that repaints several times a
 * second, so everything on this side is plain functions over a snapshot. No
 * Effect reaches here.
 */
export function statusIcon(task: TaskView): string {
  // A child blocked on a question is running, but saying so hides the one row
  // the reader can act on.
  if (task.waiting && task.status === "running") {
    return "⏸";
  }
  switch (task.status) {
    case "pending":
      return "○";
    case "running":
      return "•";
    case "skipped":
      return "⊘";
    case "settled":
      return task.outcome === "completed" || task.outcome === "wrapped_up" ? "✓" : "✗";
  }
}

function statusColor(task: TaskView): ThemeColor {
  if (task.waiting && task.status === "running") {
    return "warning";
  }
  switch (task.status) {
    case "pending":
      return "muted";
    case "running":
      return "accent";
    case "skipped":
      return "warning";
    case "settled":
      return task.outcome === "completed" || task.outcome === "wrapped_up" ? "success" : "error";
  }
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  const thousands = tokens / 1000;
  return thousands < 100 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * Zero prints nothing rather than a zero-dollar figure, which would claim the
 * run was measured and found free: a model Pi has no rates for contributes
 * nothing, and that is not the same as being free. A real cost too small to
 * render says so instead of rounding away to nothing.
 */
export function formatCost(cost: number): string | undefined {
  if (!(cost > 0)) {
    return undefined;
  }
  return cost >= 0.0001 ? `$${cost.toFixed(4)}` : "<$0.0001";
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

export function formatElapsed(task: TaskView, now: number): string {
  if (task.startedAt === undefined) {
    return "–";
  }
  return formatDuration((task.endedAt ?? now) - task.startedAt);
}

const TERMINAL: readonly TaskStatus[] = ["settled", "skipped"];

function isDone(task: TaskView): boolean {
  return TERMINAL.includes(task.status);
}

/**
 * One task, one line: what it is, what it just did, and what it has cost. The
 * activity is what makes a slow child legible, so it survives at the expense of
 * the numbers when the terminal is narrow.
 */
export function widgetLine(task: TaskView, theme: Theme, now: number): string {
  const icon = theme.fg(statusColor(task), statusIcon(task));
  const name = theme.fg(isDone(task) ? "dim" : "accent", task.agent);
  const cost = formatCost(task.cost);
  const stats = theme.fg(
    "dim",
    `${task.toolCalls} tools · ${formatTokens(task.tokens)} tok · ${cost ? `${cost} · ` : ""}${formatElapsed(task, now)}`,
  );
  // The ask takes the activity slot rather than sitting beside it. A blocked
  // child's last tool call was the ask itself, so printing both says it twice.
  const blocked = !isDone(task) && task.waiting ? task.waiting : undefined;
  const asks = blocked
    ? `${theme.fg("warning", `asks · ${formatDuration(now - blocked.since)}`)} · `
    : "";
  const activity =
    !isDone(task) && !blocked && task.activity
      ? `${theme.fg("muted", `→ ${task.activity}`)} · `
      : "";
  // Beside the activity rather than replacing it: when a child goes quiet, the
  // tool it went quiet on is the most useful thing on the line. Ahead of the
  // stats, so the narrow-terminal truncation eats the numbers first.
  const quiet = quietSegment(task, blocked, theme, now);
  const waitsFor =
    task.status === "pending" && task.needs.length > 0
      ? `${theme.fg("muted", `↳ waits ${task.needs.join(", ")}`)} · `
      : "";
  return `${icon} ${name} · ${waitsFor}${asks}${activity}${quiet}${stats}`;
}

/**
 * How long the child has been silent, once that is long enough to be worth
 * saying. "quiet" and not "idle" or "stuck": all this measures is an absence of
 * output, and a child mid-build is neither idle nor stuck.
 *
 * A blocked child is skipped because the ask already carries its own elapsed,
 * measured against the parent reply timeout, which says the same thing better
 * and names the reason. A task that has not started is skipped because waiting
 * on an upstream edge is the graph working, not a child going quiet.
 */
function quietSegment(
  task: TaskView,
  blocked: AskWaiting | undefined,
  theme: Theme,
  now: number,
): string {
  if (isDone(task) || blocked || task.status !== "running") {
    return "";
  }
  // Falls back to startedAt: a child that has said nothing at all since
  // dispatch is the case most worth surfacing, not the one to stay silent on.
  const since = task.lastActivityAt ?? task.startedAt;
  if (since === undefined || now - since < QUIET_AFTER_MS) {
    return "";
  }
  return `${theme.fg("muted", `quiet ${formatDuration(now - since)}`)} · `;
}

export function widgetLines(runs: readonly RunView[], theme: Theme, now: number): string[] {
  const tasks = runs.flatMap((run) => run.tasks);
  if (tasks.length === 0) {
    return [];
  }

  const done = tasks.filter(isDone).length;
  const live = tasks.length - done;
  const head: ThemeColor = live > 0 ? "accent" : "dim";
  const lines = [
    `${theme.fg(head, live > 0 ? "●" : "○")} ${theme.fg(head, `Subagents (${done}/${tasks.length})`)}`,
  ];

  // Unfinished work first: a widget that has run out of room should be showing
  // what is still happening, not what already finished.
  const ordered = [...tasks.filter((task) => !isDone(task)), ...tasks.filter(isDone)];
  // The header and the "+n more" line come out of the same budget, so the
  // widget stays the same height whether or not it overflowed.
  const room = WIDGET_MAX_LINES - 1;
  const shown = tasks.length > room ? room - 1 : tasks.length;
  for (const task of ordered.slice(0, shown)) {
    lines.push(`${theme.fg("dim", "├─")} ${widgetLine(task, theme, now)}`);
  }

  const hidden = tasks.length - shown;
  if (hidden > 0) {
    lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`);
  } else if (lines.length > 1) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace("├─", "└─");
  }
  return lines;
}

/** The widget above the editor. Reads a snapshot; never awaits, never blocks. */
export class SubagentWidget implements Component {
  constructor(
    private readonly runs: () => readonly RunView[],
    private readonly theme: Theme,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return widgetLines(this.runs(), this.theme, this.now()).map((line) =>
      truncateToWidth(line, width, "…"),
    );
  }
}

/**
 * Which runs the widget draws, as opposed to which ones exist. The manager
 * keeps every run for the whole session so `subagent_result` can still reach
 * one by id. The widget is a live status display, so it drops a run once the
 * turn that read it is over. Without this the rows of every run ever started
 * pile up, and a second batch reads as "2/2" beside a task that settled turns
 * ago.
 *
 * The turn boundary is `agent_settled`, not `agent_start`. Pi fires
 * `agent_start` again for a retry, an auto-compaction or a queued follow-up, so
 * an `agent_start` with no `agent_settled` before it is the same turn resuming
 * and must leave the rows alone.
 */
export interface WidgetRuns {
  /** What the widget reads. Never awaits; safe inside a render. */
  readonly current: () => readonly RunView[];
  /** The manager pushed a fresh snapshot of every run it holds. */
  replace(all: readonly RunView[]): void;
  /** The turn ended. Nothing is dropped yet: the reader is still looking. */
  endTurn(): void;
  /** A new turn began. Finished runs stop being drawn. True if any went. */
  beginTurn(): boolean;
}

export function createWidgetRuns(): WidgetRuns {
  let runs: readonly RunView[] = [];
  const dismissed = new Set<string>();
  let ended = false;

  return {
    current: () => runs,
    replace(all) {
      runs = all.filter((run) => !dismissed.has(run.id));
    },
    endTurn() {
      ended = true;
    },
    beginTurn() {
      if (!ended) {
        return false;
      }
      ended = false;
      const gone = runs.filter((run) => run.finished);
      // Remembered by id, because the manager keeps pushing every run it holds
      // and a dropped one would otherwise come straight back on the next
      // snapshot. A live run keeps its rows however long it takes.
      for (const run of gone) {
        dismissed.add(run.id);
      }
      runs = runs.filter((run) => !run.finished);
      return gone.length > 0;
    },
  };
}

export interface WidgetHost {
  /** Called on every change. Mounts the widget once, then repaints on a timer. */
  update(ctx: ExtensionContext | undefined): void;
  clear(ctx: ExtensionContext | undefined): void;
}

/**
 * Mount and repaint. The extension has no `ctx` until a tool runs, so the
 * widget appears with the first run rather than at activation.
 */
export function createWidgetHost(
  runs: () => readonly RunView[],
  throttleMs = WIDGET_THROTTLE_MS,
): WidgetHost {
  let tui: TUI | undefined;
  let mounted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const hasUnsettled = (): boolean => runs().some((run) => !run.finished);

  const startHeartbeat = (): void => {
    if (heartbeat) {
      return;
    }
    heartbeat = setInterval(() => {
      tui?.requestRender();
    }, 1000);
    heartbeat.unref?.();
  };

  const stopHeartbeat = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const mount = (ctx: ExtensionContext): void => {
    if (mounted || !ctx.hasUI) {
      return;
    }
    mounted = true;
    try {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (hostTui, theme) => {
          tui = hostTui;
          return new SubagentWidget(runs, theme);
        },
        { placement: "aboveEditor" },
      );
    } catch {
      // A widget that will not mount is not worth failing a tool call over.
    }
  };

  return {
    update(ctx) {
      if (!ctx?.hasUI) {
        return;
      }
      mount(ctx);
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          tui?.requestRender();
        }, throttleMs);
        // Keeping the process alive for a repaint would hold a CLI session open
        // after its work is done.
        timer.unref?.();
      }
      if (hasUnsettled()) {
        startHeartbeat();
      } else {
        stopHeartbeat();
      }
    },
    clear(ctx) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      stopHeartbeat();
      tui = undefined;
      if (!mounted) {
        return;
      }
      mounted = false;
      try {
        ctx?.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // Shutdown races the TUI tearing itself down; there is nothing to fix.
      }
    },
  };
}

// --- the call preview --------------------------------------------------------

/** A task as it looks mid-stream: the model is still typing, so nothing is sure. */
interface PartialTask {
  readonly id?: JsonValue | undefined;
  readonly agent?: JsonValue | undefined;
  /** The three-to-five word label, which is what the row shows. */
  readonly task?: JsonValue | undefined;
  /** The whole instruction. Only the expanded row has room for it. */
  readonly prompt?: JsonValue | undefined;
  readonly needs?: JsonValue | undefined;
}

function text(value: unknown): string | undefined {
  if (!Predicate.isString(value)) {
    return undefined;
  }
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
}

function truncate(value: string, max = GOAL_MAX): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function edges(needs: unknown): string[] {
  return Array.isArray(needs) ? needs.flatMap((need) => text(need) ?? []) : [];
}

/**
 * The prompt as the child will read it, not as `text` would flatten it. A goal
 * on one line wants its whitespace collapsed; a prompt of twenty does not.
 */
function promptLines(value: unknown): readonly string[] {
  if (!Predicate.isString(value)) {
    return [];
  }
  const body = value.trim();
  return body === "" ? [] : body.split("\n");
}

/**
 * A prompt as indented lines, capped, with a line saying what was held back.
 * The call row and the result row share it so the cap and the pointer cannot
 * drift apart: they are showing the same prompt at two moments.
 */
function promptBlock(value: unknown, theme: Theme, indent: string): string[] {
  const prompt = promptLines(value);
  const kept = prompt.slice(0, PROMPT_MAX_LINES).map((line) => `${indent}${theme.fg("dim", line)}`);
  const dropped = prompt.length - PROMPT_MAX_LINES;
  if (dropped <= 0) {
    return kept;
  }
  const held = `… +${dropped} ${dropped === 1 ? "line" : "lines"}`;
  return [...kept, `${indent}${theme.fg("muted", held)}`];
}

/**
 * Drawn while the arguments are still streaming, so every field is optional and
 * every type is a guess. It costs nothing and it is the difference between
 * watching a plan appear and watching a spinner.
 *
 * Expanded, it prints each task's prompt instead of a 64 character slice of it,
 * which is the only place the prompt the orchestrator wrote is readable in full.
 */
export function callLines(args: unknown, theme: Theme, expanded = false): string[] {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const tasks: PartialTask[] = Array.isArray((args as { tasks?: unknown } | undefined)?.tasks)
    ? // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
      ((args as { tasks: unknown[] }).tasks.filter(Predicate.isObject) as PartialTask[])
    : [];
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const autoAwait = (args as { autoAwait?: unknown } | undefined)?.autoAwait === true;

  const displayShape =
    tasks.length === 0
      ? "preparing…"
      : `${tasks.some((task) => edges(task.needs).length > 0) ? "graph" : "parallel"} ${tasks.length}`;
  const lines = [
    `${theme.fg("toolTitle", "subagent")} ${theme.fg("accent", displayShape)} ${theme.fg("muted", autoAwait ? "[await]" : "[background]")}`,
  ];

  for (const [index, task] of tasks.entries()) {
    const id = text(task.id) ?? `task_${index + 1}`;
    const agent = text(task.agent) ?? "…";
    const needs = edges(task.needs);
    const edge = needs.length > 0 ? theme.fg("muted", ` ← ${needs.join(", ")}`) : "";
    const goal = text(task.task);
    lines.push(
      `  ${theme.fg("muted", id)} ${theme.fg("accent", agent)}${edge}${goal ? ` ${theme.fg("dim", truncate(goal))}` : ""}`,
    );
    if (expanded) {
      // The prompt as typed. `{previous}` is still a hole here, because the
      // call row reads tool arguments and substitution happens at dispatch.
      lines.push(...promptBlock(task.prompt, theme, "    "));
    }
  }
  return lines;
}

// --- the result --------------------------------------------------------------

function summaryLine(run: RunView, theme: Theme): string {
  const done = run.tasks.filter(isDone).length;
  const failed = run.tasks.filter(
    (task) =>
      task.status === "skipped" || (task.outcome !== undefined && task.outcome !== "completed"),
  ).length;
  const state = run.cancelled ? "cancelled" : run.finished ? "settled" : "running";
  const usage = aggregateUsage(run.tasks);
  const cost = formatCost(usage.cost);
  const tail = theme.fg(
    "dim",
    `${failed > 0 ? `${failed} not clean · ` : ""}${formatTokens(usage.tokens)} tok${cost ? ` · ${cost}` : ""}`,
  );
  return `${theme.fg(failed > 0 ? "warning" : "success", `${done}/${run.tasks.length} done`)} ${theme.fg("muted", state)} · ${tail}`;
}

export function resultLines(
  run: RunView,
  theme: Theme,
  expanded: boolean,
  now: number = Date.now(),
): string[] {
  const lines = [summaryLine(run, theme)];
  if (!expanded) {
    return lines;
  }

  for (const task of run.tasks) {
    lines.push(`  ${widgetLine(task, theme, now)}`);
    if (task.status === "skipped") {
      lines.push(
        `    ${theme.fg("warning", `skipped: ${task.missing.join(", ")} produced nothing`)}`,
      );
      continue;
    }
    // What the child was actually sent, upstream output spliced in. Labelled,
    // because an unlabelled block above the output reads as more output.
    const prompt = promptBlock(task.prompt, theme, "      ");
    if (prompt.length > 0) {
      lines.push(`    ${theme.fg("muted", "prompt:")}`, ...prompt);
    }
    // The answer gets the same treatment as the prompt above it. It used to go
    // through `text`, which flattens every newline, and then a 120 character
    // cut, so a multi-line answer arrived as one squashed line: 24k retained by
    // RESULT_CAP_BYTES, 120 of it readable. Reading a prompt against the answer
    // it produced is the whole reason to expand this row.
    const answer = promptBlock(task.output, theme, "      ");
    if (answer.length > 0) {
      lines.push(`    ${theme.fg("muted", "output:")}`, ...answer);
    }
    if (task.sessionFile) {
      lines.push(`    ${theme.fg("muted", task.sessionFile)}`);
    }
  }
  return lines;
}
