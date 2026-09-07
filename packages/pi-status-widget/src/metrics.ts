import { isRecord, type SessionMetrics } from "./types.js";
function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Intentionally loose structural projection of the `usage` field on a Pi session
 * message entry. Fields stay `unknown` and are validated at runtime rather than
 * derived from Pi's SDK types, which keeps the parsing robust to upstream shape
 * changes.
 */
interface UsageLike {
  cost?: {
    total?: unknown;
  };
}

/**
 * Same rationale as UsageLike, for a session message entry as
 * sessionManager.getBranch() returns it.
 */
interface MessageLike {
  role?: unknown;
  timestamp?: unknown;
  usage?: unknown;
}

/**
 * Walks the session branch for the two numbers a shipped widget reads: total
 * cost and the earliest timestamp. pi-footer also accumulates input, output and
 * cache token counts, message counts by role, compactions and per-turn totals,
 * every one of which fed a widget this package does not ship.
 *
 * Nothing here throws. An entry that does not look like a message, a timestamp
 * that will not parse and a cost that is not a finite number are all skipped,
 * because a malformed entry should cost one segment rather than the footer.
 */
export function collectSessionMetrics(entries: readonly unknown[]): SessionMetrics {
  let costUsd = 0;
  let firstTimestampMs: number | undefined;

  for (const entry of entries) {
    const message = getMessage(entry);
    if (!message) {
      continue;
    }

    const timestampMs = normalizeTimestamp(message.timestamp ?? getEntryTimestamp(entry));
    if (timestampMs !== undefined) {
      firstTimestampMs =
        firstTimestampMs === undefined ? timestampMs : Math.min(firstTimestampMs, timestampMs);
    }

    if (message.role !== "assistant") {
      continue;
    }
    const usage = getUsage(message.usage);
    if (usage) {
      costUsd += numberOrZero(usage.cost?.total);
    }
  }

  return { costUsd, firstTimestampMs };
}

function getMessage(entry: unknown): MessageLike | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const message = entry.message;
  return isRecord(message) ? message : undefined;
}

/** A message without its own timestamp falls back to the entry wrapping it. */
function getEntryTimestamp(entry: unknown): string | number | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const timestamp = entry.timestamp;
  if (isString(timestamp) || isNumber(timestamp)) {
    return timestamp;
  }
  return undefined;
}

function getUsage(value: unknown): UsageLike | undefined {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  return isRecord(value) ? (value as UsageLike) : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (isNumber(value) && Number.isFinite(value)) {
    return value;
  }
  if (!isString(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrZero(value: unknown): number {
  return isNumber(value) && Number.isFinite(value) ? value : 0;
}
