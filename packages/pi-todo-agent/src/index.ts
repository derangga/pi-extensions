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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { replayFromBranch } from "./state/replay.js";
import {
  clearActiveRenderSession,
  evictSession,
  getActiveRenderSession,
  replaceState,
  setActiveRenderSession,
  sid,
} from "./state/store.js";
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

  pi.on("session_start", async (_event, ctx) => {
    const id = replaySessionSlot(ctx);
    if (id === undefined) {
      return;
    }
    if (!ctx.hasUI) {
      return;
    }
    // First UI-bearing session_start claims the foreground render pointer
    // without eagerly loading the overlay; later (child) sessions keep
    // their own slots and never rebind the shared widget.
    if (getActiveRenderSession() === "") {
      setActiveRenderSession(id);
    }
  });

  // Compaction and branch edits rebuild state from the persisted snapshot;
  // the slot survives with the same key, so the foreground stays bound.
  pi.on("session_compact", (_event, ctx) => {
    replaySessionSlot(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    replaySessionSlot(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
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
    }
  });
}
