import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Predicate } from "effect";

import type { RunView, TaskStatus, TaskView } from "./run.js";

/**
 * Roughly one render per 150ms. A child streaming tokens fires the change hook
 * far faster than a terminal can usefully repaint.
 */
export const WIDGET_THROTTLE_MS = 150;
export const WIDGET_KEY = "pi-subagent";
/** Header plus tasks. Past this the widget is eating the transcript. */
export const WIDGET_MAX_LINES = 9;
const GOAL_MAX = 64;

/**
 * Pi's Component is a synchronous `render(width)` that repaints several times a
 * second, so everything on this side is plain functions over a snapshot. No
 * Effect reaches here.
 */
export function statusIcon(task: TaskView): string {
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
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return thousands < 100 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

export function formatElapsed(task: TaskView, now: number): string {
  if (task.startedAt === undefined) return "–";
  const seconds = Math.max(0, Math.round(((task.endedAt ?? now) - task.startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
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
  const stats = theme.fg(
    "dim",
    `${task.toolCalls} tools · ${formatTokens(task.tokens)} tok · ${formatElapsed(task, now)}`,
  );
  const activity =
    !isDone(task) && task.activity ? `${theme.fg("muted", `→ ${task.activity}`)} · ` : "";
  const waiting =
    task.status === "pending" && task.needs.length > 0
      ? `${theme.fg("muted", `↳ waits ${task.needs.join(", ")}`)} · `
      : "";
  return `${icon} ${name} · ${waiting}${activity}${stats}`;
}

export function widgetLines(runs: readonly RunView[], theme: Theme, now: number): string[] {
  const tasks = runs.flatMap((run) => run.tasks);
  if (tasks.length === 0) return [];

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
  if (hidden > 0) lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`);
  else if (lines.length > 1) {
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

  const mount = (ctx: ExtensionContext): void => {
    if (mounted || !ctx.hasUI) return;
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
      if (!ctx?.hasUI) return;
      mount(ctx);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        tui?.requestRender();
      }, throttleMs);
      // Keeping the process alive for a repaint would hold a CLI session open
      // after its work is done.
      timer.unref?.();
    },
    clear(ctx) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      tui = undefined;
      if (!mounted) return;
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
  readonly id?: unknown;
  readonly agent?: unknown;
  readonly task?: unknown;
  readonly needs?: unknown;
}

function text(value: unknown): string | undefined {
  if (!Predicate.isString(value)) return undefined;
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
 * Drawn while the arguments are still streaming, so every field is optional and
 * every type is a guess. It costs nothing and it is the difference between
 * watching a plan appear and watching a spinner.
 */
export function callLines(args: unknown, theme: Theme): string[] {
  const tasks: PartialTask[] = Array.isArray((args as { tasks?: unknown } | undefined)?.tasks)
    ? ((args as { tasks: unknown[] }).tasks.filter(Predicate.isObject) as PartialTask[])
    : [];
  const autoAwait = (args as { autoAwait?: unknown } | undefined)?.autoAwait === true;

  const shape =
    tasks.length === 0
      ? "preparing…"
      : `${tasks.some((task) => edges(task.needs).length > 0) ? "graph" : "parallel"} ${tasks.length}`;
  const lines = [
    `${theme.fg("toolTitle", "subagent")} ${theme.fg("accent", shape)} ${theme.fg("muted", autoAwait ? "[await]" : "[background]")}`,
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
  const tokens = run.tasks.reduce((total, task) => total + task.tokens, 0);
  const tail = theme.fg(
    "dim",
    `${failed > 0 ? `${failed} not clean · ` : ""}${formatTokens(tokens)} tok`,
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
  if (!expanded) return lines;

  for (const task of run.tasks) {
    lines.push(`  ${widgetLine(task, theme, now)}`);
    if (task.status === "skipped") {
      lines.push(
        `    ${theme.fg("warning", `skipped: ${task.missing.join(", ")} produced nothing`)}`,
      );
      continue;
    }
    const body = text(task.output);
    if (body) lines.push(`    ${theme.fg("dim", truncate(body, 120))}`);
    if (task.sessionFile) lines.push(`    ${theme.fg("muted", task.sessionFile)}`);
  }
  return lines;
}
