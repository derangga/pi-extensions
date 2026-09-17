/**
 * task-lines.ts — shared row projection and formatting for anything that
 * renders a todo list as `├─ status #id subject` tree lines: the sticky
 * overlay (todo-overlay.ts) and the completed-list transcript entry
 * (todo-entry.ts). One glyph table, one strikethrough rule, one heading
 * format, so the two never drift apart.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { liveDepIds } from "./state/task-graph.js";
import { sanitizeTerminalText } from "./tool/sanitize.js";
import type { Task, TaskStatus } from "./tool/types.js";

export const HEADING_TEXT = "Todos";

export interface TaskLine {
  glyph: string;
  id: number;
  subject: string;
  activeForm?: string | undefined;
  blockedBy?: number[] | undefined;
  status: TaskStatus;
}

export interface StatusCounts {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
}

export function statusGlyph(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◎";
    case "completed":
      return "✓";
    case "deleted":
      return "✗";
    default: {
      // TaskStatus is a closed union; this keeps the switch total.
      return "?";
    }
  }
}

export function countByStatus(tasks: readonly TaskLine[]): StatusCounts {
  const counts: StatusCounts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const t of tasks) {
    if (t.status === "pending") {
      counts.pending += 1;
    } else if (t.status === "in_progress") {
      counts.in_progress += 1;
    } else if (t.status === "completed") {
      counts.completed += 1;
    }
  }
  return counts;
}

/** Project tasks into row models, dropping tombstones and any caller-hidden rows. */
export function toLines(
  tasks: readonly Task[],
  keep: (t: Task) => boolean = () => true,
): TaskLine[] {
  const lines: TaskLine[] = [];
  for (const t of tasks) {
    if (t.status === "deleted" || !keep(t)) {
      continue;
    }
    const line: TaskLine = {
      glyph: statusGlyph(t.status),
      id: t.id,
      subject: t.subject,
      status: t.status,
    };
    if (t.status === "in_progress" && t.activeForm !== undefined) {
      line.activeForm = t.activeForm;
    }
    if (t.blockedBy !== undefined) {
      // Tombstoned dep ids are dropped so a chain never points at nothing.
      const liveDeps = liveDepIds(tasks, t.blockedBy);
      if (liveDeps.length > 0) {
        line.blockedBy = liveDeps;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function formatTaskLine(t: TaskLine, theme: Theme, showId: boolean): string {
  let subjectColor: "accent" | "muted" | "text" = "text";
  if (t.status === "in_progress") {
    subjectColor = "accent";
  } else if (t.status === "completed") {
    subjectColor = "muted";
  }
  let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
  if (t.status === "completed") {
    subject = theme.strikethrough(subject);
  }
  if (t.status === "in_progress") {
    // A weight difference, like the strike on completed, reads even where
    // accent colors are muted or color-blind palettes collapse them.
    subject = theme.bold(subject);
  }
  let line = t.glyph;
  if (showId) {
    line += ` ${theme.fg("dim", `#${t.id}`)}`;
  }
  line += ` ${subject}`;
  if (t.activeForm) {
    line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  return line;
}
