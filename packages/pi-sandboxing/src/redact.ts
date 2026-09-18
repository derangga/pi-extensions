/**
 * Replacing harvested values with placeholders, and forgetting the ones the
 * user has approved seeing in full.
 *
 * Nothing here imports Pi. The store is the only mutable state the extension
 * keeps, and it is the whole reason the gate and the redactor need no
 * bookkeeping between them: approving a read burns that file's needles before
 * the tool runs, so the redactor handles the approved result by finding nothing
 * left to replace.
 */
import type { Needle } from "./harvest.js";

export interface NeedleStore {
  /** Active needles, longest value first. */
  needles: Needle[];
  /** Values the user approved in full. Burned for the session, never restored. */
  burned: Set<string>;
}

export interface Redaction {
  text: string;
  /** Distinct labels replaced in this pass, for the count and the first-hit notice. */
  labels: string[];
}

function placeholder(label: string): string {
  return `[redacted: ${label}]`;
}

/**
 * Longest value first. A short needle nested inside a longer one would
 * otherwise fire first and leave the tail of the longer secret in the output.
 */
function sortLongestFirst(needles: readonly Needle[]): Needle[] {
  return [...needles].sort((left, right) => right.value.length - left.value.length);
}

export function createStore(needles: readonly Needle[]): NeedleStore {
  return { needles: sortLongestFirst(needles), burned: new Set() };
}

/** How many needles are still being looked for. */
export function activeCount(store: NeedleStore): number {
  return store.needles.length;
}

/**
 * Forget every needle read from one file, because the user approved seeing it.
 * Returns the labels that were dropped, for the status line.
 */
export function burnOrigin(store: NeedleStore, origin: string): string[] {
  const burned: string[] = [];
  const kept: Needle[] = [];
  for (const needle of store.needles) {
    if (needle.origin === origin) {
      store.burned.add(needle.value);
      burned.push(needle.label);
      continue;
    }
    kept.push(needle);
  }
  store.needles = kept;
  return [...new Set(burned)];
}

/**
 * Swap one file's needles for the ones it holds now, after a write or an edit.
 * A value burned earlier stays burned: it is already in the model's context,
 * and redacting its echo would protect nothing while making the transcript lie.
 */
export function refreshOrigin(
  store: NeedleStore,
  origin: string,
  needles: readonly Needle[],
): void {
  const others = store.needles.filter((needle) => needle.origin !== origin);
  const arrivals = needles.filter((needle) => !store.burned.has(needle.value));
  store.needles = sortLongestFirst([...others, ...arrivals]);
}

/** Plain substring replacement, every occurrence, longest needle first. */
export function redact(store: NeedleStore, text: string): Redaction {
  let output = text;
  const labels: string[] = [];
  for (const needle of store.needles) {
    if (!output.includes(needle.value)) {
      continue;
    }
    output = output.split(needle.value).join(placeholder(needle.label));
    labels.push(needle.label);
  }
  return { text: output, labels: [...new Set(labels)] };
}
