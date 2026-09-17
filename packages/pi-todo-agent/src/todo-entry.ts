/**
 * todo-entry.ts — the completed-list transcript block. Appended once, via
 * pi.appendEntry, the instant the todo list closes (see index.ts); rendered
 * via pi.registerEntryRenderer, on every repaint and on session reload.
 *
 * Display-only: a custom entry does not participate in LLM context (per the
 * SDK contract on CustomEntry), so this is scrollback for the human, not a
 * message the model ever reads.
 */
import type { CustomEntry, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { countByStatus, formatTaskLine, HEADING_TEXT, toLines } from "./task-lines.js";
import type { Task } from "./tool/types.js";

/** Entry registry key. Ours, namespaced so it can never collide with another
 * extension's customType. */
export const ENTRY_TYPE = "pi-todo-agent:completed";

export interface CompletedTodoEntry {
  tasks: Task[];
}

/**
 * Register the renderer once at extension load. The renderer must rebuild
 * the block purely from `entry.data` — it has no access to the store, and
 * it is re-invoked on every repaint and again after a session reload.
 */
export function registerTodoEntryRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<CompletedTodoEntry>(ENTRY_TYPE, (entry, _options, theme) =>
    renderCompletedTodos(entry, theme),
  );
}

/** Append the finished list. Snapshots `state.tasks` so the entry survives
 * independently of whatever the live store does next. */
export function appendCompletedTodos(pi: ExtensionAPI, tasks: readonly Task[]): void {
  pi.appendEntry<CompletedTodoEntry>(ENTRY_TYPE, { tasks: [...tasks] });
}

function renderCompletedTodos(entry: CustomEntry<CompletedTodoEntry>, theme: Theme): Box {
  const tasks = toLines(entry.data?.tasks ?? []);
  const counts = countByStatus(tasks);
  const showIds = tasks.some((t) => t.blockedBy && t.blockedBy.length > 0);

  const box = new Box(1, 0);
  box.addChild(
    new Text(theme.fg("dim", `${HEADING_TEXT} (${counts.completed}/${counts.total})`), 0, 0),
  );
  for (const task of tasks) {
    box.addChild(new Text(`${theme.fg("dim", "·")} ${formatTaskLine(task, theme, showIds)}`, 0, 0));
  }
  return box;
}
