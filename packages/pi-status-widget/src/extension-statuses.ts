import { STATUS_KEY } from "./config.js";
import type { GetExtensionStatuses } from "./types.js";

export type { GetExtensionStatuses };

export const EMPTY_EXTENSION_STATUSES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Every other extension's published status, sorted by key so the row does not
 * reshuffle between draws.
 *
 * Read-only on purpose. pi-footer carries hidden keys, known keys, a picker and
 * a config normalizer so someone can hide a status from the row; all of that
 * lived in the config TUI. Without it, an extension that publishes a status
 * while pi-statusbar owns the footer stays visible rather than disappearing
 * with no way to ask why.
 */
export function extensionStatusValues(statuses: ReadonlyMap<string, string>): string[] {
  return [...statuses.entries()]
    .filter(([key, value]) => key !== STATUS_KEY && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}
