import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Per-session live state: a Map partitioned by session id, so a detached or
 * child session (distinct sid) can never read or clobber another session's
 * tasks. The Map is the single mutation seam — only commitState /
 * replaceState / evictSession write it; the reducer stays pure.
 */
const sessions = new Map<string, TaskState>();

/**
 * Per-session commit queues. Two todo calls can still arrive interleaved (a
 * host that ignores executionMode, or a future second entry point), so the
 * seam serializes its own read-modify-write cycles instead of trusting the
 * caller to.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Ctx-less render pointer: which slot do the ctx-free readers (the overlay
 * snapshot, the tool's renderCall) render? Set when the first UI session
 * claims the foreground.
 */
let activeRenderSession = "";

/**
 * Session-id extractor. Structural ctx type — no Pi-runtime import, so the
 * state layer stays host-free. An unknown/empty session resolves to "" and
 * keeps the key a plain string.
 */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

/** Fresh, non-aliasing EMPTY_STATE copy (never returns EMPTY_STATE.tasks). */
function freshState(): TaskState {
  return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

/** The committed slot by identity, or a fresh empty copy when absent (not stored).
 *  Reads copy, so a caller nudging the returned snapshot can never reach the
 *  live cell — commitState is the only path back in. */
function slotFor(sessionId: string): TaskState {
  const slot = sessions.get(sessionId);
  if (!slot) {
    return freshState();
  }
  return { tasks: [...slot.tasks], nextId: slot.nextId };
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
  return slotFor(sessionId);
}

/**
 * Replay seam. Lifecycle handlers call this on session_start /
 * session_compact / session_tree after replayFromBranch decodes the latest
 * snapshot, keyed to the session.
 */
export function replaceState(sessionId: string, next: TaskState): void {
  sessions.set(sessionId, next);
}

/**
 * Post-reducer commit seam. The tool's execute() publishes the reducer's new
 * state here so live readers (overlay, renderCall) see it, keyed to the
 * calling session.
 */
export function commitState(sessionId: string, next: TaskState): void {
  sessions.set(sessionId, next);
}

/** Drop a session's slot on session_shutdown. No-op if the slot is absent.
 * Also drops the commit queue; any in-flight closure still runs, a later
 * caller just starts on a fresh chain. */
export function evictSession(sessionId: string): void {
  sessions.delete(sessionId);
  queues.delete(sessionId);
}

/**
 * Run `fn` exclusively per session: chained after the previous closure for the
 * same sid, whatever its outcome. Every todo call reads state, mutates, and
 * commits inside one of these, so a batch of todo calls lands in order even
 * if the host runs them concurrently.
 */
export function runExclusive<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Ctx-less render reader: the slot the overlay and renderCall render. */
export function getRenderState(): TaskState {
  return slotFor(activeRenderSession);
}

/** Set the render pointer when the first UI session claims the foreground. */
export function setActiveRenderSession(sessionId: string): void {
  activeRenderSession = sessionId;
}

/** The sid the foreground gate compares against and getRenderState resolves to. */
export function getActiveRenderSession(): string {
  return activeRenderSession;
}

/** Foreground teardown: resets the pointer so the next UI session reclaims it. */
export function clearActiveRenderSession(): void {
  activeRenderSession = "";
}

/** Test-setup reset: clears the session Map and the render pointer. */
export function __resetState(): void {
  sessions.clear();
  activeRenderSession = "";
}
