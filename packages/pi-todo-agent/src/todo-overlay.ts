/**
 * todo-overlay.ts — Persistent widget showing the todo list above the editor.
 *
 * Lifecycle controller for Pi's setWidget contract: factory-form registration,
 * register-once + requestRender() refresh, a fixed content-row budget with
 * collapse-not-scroll truncation, tool-output expansion awareness, auto-hide
 * when nothing is visible, and completed-task fade-out at the next turn.
 *
 * Reads the live state via getRenderState() (the ctx-less foreground slot) at
 * render time — never replayFromBranch, which is stale by tool_execution_end.
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { isAllComplete } from "./state/state.js";
import { getRenderState } from "./state/store.js";
import {
  countByStatus,
  formatTaskLine,
  HEADING_TEXT,
  toLines,
  type TaskLine,
} from "./task-lines.js";
import type { Task } from "./tool/types.js";

/** Widget registry key. Ours, not inherited from any upstream package. */
export const WIDGET_KEY = "pi-todo-agent";

/** Content-row budget: heading + task rows + optional summary. */
const MAX_WIDGET_LINES = 12;

interface Snapshot {
  tasks: Task[];
  nextId: number;
}

export class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  /** Completed tasks hidden from the previous turn onward: id → subject at hide time. */
  private hiddenCompleted = new Map<number, string>();
  private lastNextId: number | undefined;

  setUICtx(ctx: ExtensionUIContext): void {
    // Identity-compare so repeat session_start handlers are idempotent;
    // on identity change (/reload) invalidate so update() re-registers.
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  isRegistered(): boolean {
    return this.widgetRegistered;
  }

  /** Called on tool_execution_end: register, refresh, or auto-hide. */
  update(): void {
    if (!this.uiCtx) {
      return;
    }
    this.syncHiddenCompleted();
    // An all-complete list is a closed list: it flushes to the transcript
    // entry (see index.ts) and the widget must never show it again, whether
    // that's this render, a later refresh, or a replay after /reload.
    if (this.visibleTasks().length === 0 || isAllComplete(this.getSnapshot())) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }
    if (this.widgetRegistered) {
      this.tui?.requestRender();
    } else {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, factoryTheme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
            invalidate: () => {
              // No rendered strings are cached; the next render reads
              // uiCtx.theme again.
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    }
  }

  /** Called at agent_start: completed rows from previous turns fade out.
   * Detected from the live state here rather than accumulated during
   * renders, so the fade happens even when nothing painted between the
   * completing tool call and this call. */
  hideCompletedTasksFromPreviousTurn(): void {
    if (!this.uiCtx) {
      return;
    }
    this.syncHiddenCompleted();
    let added = false;
    for (const task of getRenderState().tasks) {
      if (task.status === "completed" && !this.hiddenCompleted.has(task.id)) {
        this.hiddenCompleted.set(task.id, task.subject);
        added = true;
      }
    }
    if (added) {
      this.tui?.requestRender();
    }
  }

  dispose(): void {
    if (this.uiCtx) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.resetCompletedDisplayState();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private resetCompletedDisplayState(): void {
    this.hiddenCompleted.clear();
    this.lastNextId = undefined;
  }

  /**
   * Reconcile the hidden-completed map with the live state: drop entries
   * whose task is gone, no longer completed, or was replaced by a different
   * task at the same id (a clear-and-rebuild reuses ids; a subject mismatch
   * and a shrinking nextId counter both catch it). Every state read that
   * feeds a decision calls this first, so render stays a pure read.
   */
  private syncHiddenCompleted(): void {
    const state = getRenderState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.hiddenCompleted.clear();
    }
    this.lastNextId = state.nextId;
    const completedSubjects = new Map<number, string>();
    for (const t of state.tasks) {
      if (t.status === "completed") {
        completedSubjects.set(t.id, t.subject);
      }
    }
    for (const [id, subject] of this.hiddenCompleted) {
      if (completedSubjects.get(id) !== subject) {
        this.hiddenCompleted.delete(id);
      }
    }
  }

  private getSnapshot(): Snapshot {
    const state = getRenderState();
    return { tasks: [...state.tasks], nextId: state.nextId };
  }

  private visibleTasks(): TaskLine[] {
    return toLines(this.getSnapshot().tasks, (t) => !this.isHiddenCompleted(t));
  }

  private isHiddenCompleted(task: Task): boolean {
    return task.status === "completed" && this.hiddenCompleted.get(task.id) === task.subject;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.getSnapshot();
    if (isAllComplete(snapshot)) {
      return [];
    }
    const tasks = toLines(snapshot.tasks, (t) => !this.isHiddenCompleted(t));
    if (tasks.length === 0) {
      return [];
    }

    const truncate = (line: string): string => truncateToWidth(line, width, "…");
    const counts = countByStatus(tasks);
    const showIds = tasks.some((t) => t.blockedBy && t.blockedBy.length > 0);
    const hasActive = counts.pending + counts.in_progress > 0;
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const lines: string[] = [
      truncate(
        `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `${HEADING_TEXT} (${counts.completed}/${counts.total})`)}`,
      ),
    ];

    // Pi's global tool-output expansion shows every row; otherwise the
    // fixed budget applies (heading reserves one row of MAX_WIDGET_LINES).
    const expanded = this.uiCtx?.getToolsExpanded?.() === true;
    const bodyBudget = expanded ? tasks.length : MAX_WIDGET_LINES - 1;
    const layout = layOut(tasks, bodyBudget);
    for (const task of layout.visible) {
      lines.push(truncate(`${theme.fg("dim", "├─")} ${formatTaskLine(task, theme, showIds)}`));
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      const last = lines.length - 1;
      const lastLine = lines[last];
      if (lastLine) {
        lines[last] = lastLine.replace("├─", "└─");
      }
      return withTrailingSpacer(lines);
    }

    const overflowParts: string[] = [];
    if (layout.hiddenCompleted > 0) {
      overflowParts.push(`${layout.hiddenCompleted} completed`);
    }
    if (layout.truncatedTail > 0) {
      overflowParts.push(`${layout.truncatedTail} pending`);
    }
    lines.push(
      truncate(
        `${theme.fg("dim", "└─")} ${theme.fg("dim", `+${layout.hiddenCompleted + layout.truncatedTail} more (${overflowParts.join(", ")})`)}`,
      ),
    );
    return withTrailingSpacer(lines);
  }
}

function withTrailingSpacer(lines: string[]): string[] {
  if (lines.length === 0) {
    return lines;
  }
  lines.push("");
  return lines;
}

interface Layout {
  visible: TaskLine[];
  hiddenCompleted: number;
  truncatedTail: number;
}

/**
 * The "drop completed first, then truncate the non-completed tail" rule.
 * `budget` is the body-slot count (heading excluded). On overflow the
 * layout reserves one slot internally for the summary row.
 */
function layOut(tasks: TaskLine[], budget: number): Layout {
  const nonCompleted = tasks.filter((t) => t.status !== "completed");
  const totalCompleted = tasks.length - nonCompleted.length;
  if (tasks.length <= budget) {
    return { visible: tasks, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const innerBudget = budget - 1;
  if (nonCompleted.length <= innerBudget) {
    const kept = new Set(nonCompleted);
    for (const t of tasks) {
      if (kept.size >= innerBudget) {
        break;
      }
      if (t.status === "completed") {
        kept.add(t);
      }
    }
    const visible = tasks.filter((t) => kept.has(t));
    const shownCompleted = visible.filter((t) => t.status === "completed").length;
    return {
      visible,
      hiddenCompleted: totalCompleted - shownCompleted,
      truncatedTail: 0,
    };
  }
  const visible = nonCompleted.slice(0, innerBudget);
  return {
    visible,
    hiddenCompleted: totalCompleted,
    truncatedTail: nonCompleted.length - innerBudget,
  };
}
