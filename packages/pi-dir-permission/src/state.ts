/**
 * Grants live in the session, not on disk. They are appended as custom session
 * entries and replayed from the branch, so they survive a reload and follow a
 * rewind — and they die with the session. A permission that quietly outlives
 * the reason it was granted is the failure worth avoiding.
 */
import { isAbsolute } from "node:path";
import type { Grant } from "./boundary.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATE_TYPE = "dir-permission:grants";

function isGrant(value: unknown): value is Grant {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: boundary check for Grant; both fields are validated before use.
  const candidate = value as { absolutePath?: unknown; label?: unknown };
  return (
    typeof candidate.absolutePath === "string" &&
    isAbsolute(candidate.absolutePath) &&
    typeof candidate.label === "string"
  );
}

function isGrantSnapshot(value: unknown): value is { dirs: readonly unknown[] } {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: boundary check for the persisted snapshot; `dirs` is validated as
  // an array here and element by element by isGrant.
  const candidate = value as { dirs?: unknown };
  return Array.isArray(candidate.dirs);
}

/**
 * The last snapshot on the branch wins. Entries written by an older version,
 * or corrupted, are skipped rather than failing the session — a session that
 * cannot start is worse than a boundary that reverts to the workspace.
 */
export function readGrants(entries: readonly SessionEntry[]): Grant[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) {
      continue;
    }
    if (!isGrantSnapshot(entry.data)) {
      continue;
    }
    return entry.data.dirs.filter(isGrant).map((grant) => ({ ...grant }));
  }
  return [];
}

/** True when the two lists name the same directories in the same order. */
export function sameGrants(left: readonly Grant[], right: readonly Grant[]): boolean {
  return (
    left.length === right.length &&
    left.every((grant, index) => grant.absolutePath === right[index]?.absolutePath)
  );
}
