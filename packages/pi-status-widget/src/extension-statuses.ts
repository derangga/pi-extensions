import { STATUS_KEY } from "./config.js";
import type { GetExtensionStatuses } from "./types.js";

export type { GetExtensionStatuses };

export const EMPTY_EXTENSION_STATUSES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Every other extension's published status, sorted by key so the row does not
 * reshuffle between draws.
 *
 * Read-only on purpose. No hidden keys, picker, or per-status hiding is
 * provided. An extension that publishes a status while pi-statusbar owns the
 * footer stays visible rather than disappearing with no way to ask why.
 */
export function extensionStatusValues(statuses: ReadonlyMap<string, string>): string[] {
  return [...statuses.entries()]
    .filter(([key, value]) => key !== STATUS_KEY && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}
