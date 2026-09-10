/**
 * pi-todo-agent — Pi extension. Registers the `todo` tool and the persistent
 * todo overlay above the editor.
 *
 * Zero runtime dependencies: everything the host already provides
 * (@earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox) rides in
 * as peer dependencies, so an install of this package pulls nothing extra.
 *
 * Session lifecycle: every session replays its own branch into its own state
 * slot (per-session isolation), the first UI session claims the foreground
 * render pointer, and shutdown evicts. Todo state survives compaction and
 * reload because the last tool result snapshot is replayed from the branch.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { replayFromBranch } from "./state/replay.js";
import {
  clearActiveRenderSession,
  evictSession,
  getActiveRenderSession,
  replaceState,
  setActiveRenderSession,
  sid,
} from "./state/store.js";
import { TOOL_NAME } from "./tool/types.js";
import { TodoOverlay } from "./todo-overlay.js";
import { registerTodoTool } from "./todo.js";

/**
 * pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
 * proxy after session replacement/reload. Match the stable substring so
 * genuine replay bugs still propagate instead of being silently swallowed.
 */
function isStaleCtxMessage(message: string): boolean {
  return message.includes("stale after session replacement");
}

/**
 * Replay the session's branch into its own state slot. Returns the sid, or
 * undefined when the ctx is stale (pi-core invalidates the runner while
 * still emitting the event, so ctx getters may throw) — stale ctxs have
 * nothing to bind and are skipped; real replay bugs propagate.
 */
function replaySessionSlot(ctx: ExtensionContext): string | undefined {
  try {
    const id = sid(ctx);
    replaceState(id, replayFromBranch(ctx));
    return id;
  } catch (e) {
    if (!isStaleCtxMessage(String(e))) {
      throw e;
    }
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  registerTodoTool(pi);

  let todoOverlay: TodoOverlay | undefined;
  let uiCtx: ExtensionUIContext | undefined;

  /** Register/refresh the foreground overlay; a no-op until a UI session claims it. */
  function updateTodoOverlay(): void {
    if (!uiCtx) {
      return;
    }
    todoOverlay ??= new TodoOverlay();
    todoOverlay.setUICtx(uiCtx);
    todoOverlay.update();
  }

  pi.on("session_start", (_event, ctx) => {
    const id = replaySessionSlot(ctx);
    if (id === undefined) {
      return;
    }
    if (!ctx.hasUI) {
      return;
    }
    // First UI-bearing session_start claims the foreground render pointer
    // and binds the overlay; later (child) sessions keep their own slots
    // and never rebind the shared widget.
    if (getActiveRenderSession() === "") {
      setActiveRenderSession(id);
      uiCtx = ctx.ui;
      updateTodoOverlay();
    }
  });

  // Compaction and branch edits rebuild state from the persisted snapshot;
  // the slot survives with the same key, so the foreground stays bound.
  // Refresh the overlay too: the widget renders live state, but nothing
  // forces a repaint until the next todo call otherwise.
  pi.on("session_compact", (_event, ctx) => {
    const id = replaySessionSlot(ctx);
    if (id !== undefined && id === getActiveRenderSession()) {
      updateTodoOverlay();
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    const id = replaySessionSlot(ctx);
    if (id !== undefined && id === getActiveRenderSession()) {
      updateTodoOverlay();
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Best-effort sid: disposal can race a stale ctx. An unknown/stale sid
    // resolves to "" and is treated as foreground — the safe default that
    // clears the render pointer instead of leaking it.
    let s = "";
    try {
      s = sid(ctx);
    } catch (e) {
      if (!isStaleCtxMessage(String(e))) {
        throw e;
      }
    }
    evictSession(s);
    if (s === "" || s === getActiveRenderSession()) {
      clearActiveRenderSession();
      // Only the foreground's own shutdown tears the overlay down; a child
      // shutdown must not dispose the shared widget.
      try {
        todoOverlay?.dispose();
      } finally {
        todoOverlay = undefined;
        uiCtx = undefined;
      }
    }
  });

  // The overlay re-renders after every successful todo call. Reads happen at
  // render time from the foreground slot; the branch is stale by now.
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) {
      return;
    }
    try {
      updateTodoOverlay();
    } catch {
      // The tool itself succeeded and there is no user-facing log channel in
      // this package; a transient refresh failure costs this one update and
      // the next todo call retries.
    }
  });

  // Completed tasks from previous turns fade out when new work begins.
  pi.on("agent_start", () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}
