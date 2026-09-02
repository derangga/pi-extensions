import type { QuestionData } from "../tool/types.js";

/**
 * Row kind discriminator, and the single source of truth for it.
 *
 * Upstream derived this from the view layer's `WrappingSelectItem` union. The
 * direction is inverted here: intent is a property of the protocol, not of the
 * renderer, so the union lives at the bottom of the dependency graph and the
 * view builds its item type from it. The compile-time forcing gets stronger
 * rather than weaker. Adding a kind here breaks `ROW_INTENT_META` (a
 * `Record<RowKind, ...>`) AND every exhaustive switch in the renderer, so a new
 * row cannot ship half-wired.
 */
export type RowKind = "option" | "other" | "next";

/**
 * Sentinel kinds: the protocol-driven rows, as opposed to author-defined
 * `option` rows. The auto-append walker, the reserved-label derivation and
 * `LABELS_BY_KIND` all iterate this list.
 */
export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = ["other", "next"];

/**
 * Per-kind static metadata. Pure data. No closures, no per-kind handlers.
 * The behavior-bearing code (answer construction in the key router, the Next
 * row branch in the multi-select view, the inline editor branch in the option
 * renderer) keeps its own exhaustive switches and READS these flags.
 *
 * Adding a sentinel:
 *   1. Add the variant to `RowKind`.
 *   2. Add an entry here. Compilation fails until both edits exist.
 *   3. If user-facing, synthesize the row wherever it belongs, typically in
 *      the per-question item builder.
 *
 * Field semantics:
 * - `label` — user-facing text. Empty for `option`, whose label is per-instance
 *   and comes from `QuestionData.options[i].label`. Every sentinel treats its
 *   entry here as the single source of truth.
 * - `reserved` — an authored option carrying this label is rejected at
 *   validation time. `RESERVED_LABEL_SET` derives from this flag.
 * - `livesInMainList` — the row appears in the tab's item array.
 * - `numbered` — the row contributes to main-list numbering. The multi-select
 *   `Next` row is the only listed row that does not.
 * - `activatesInputMode` — focusing the row flips `state.inputMode`, turning it
 *   into an inline editor. Read by the reducer's `nav` case.
 * - `blocksMultiToggle` — in multi-select, Space and Enter-as-toggle are
 *   suppressed on this row. `Next` only.
 * - `autoSubmitsInMulti` — in multi-select, Enter on this row commits the
 *   question. `Next` only.
 * - `autoAppendOnSingleSelect` / `autoAppendOnMultiSelect` — whether the item
 *   builder appends this row in that mode.
 */
export interface RowIntentMeta {
  label: string;
  reserved: boolean;
  livesInMainList: boolean;
  numbered: boolean;
  activatesInputMode: boolean;
  blocksMultiToggle: boolean;
  autoSubmitsInMulti: boolean;
  autoAppendOnSingleSelect: boolean;
  autoAppendOnMultiSelect: boolean;
}

export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
  option: {
    label: "",
    reserved: false,
    livesInMainList: true,
    numbered: true,
    activatesInputMode: false,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: false,
  },
  other: {
    label: "Type something.",
    reserved: true,
    livesInMainList: true,
    numbered: true,
    activatesInputMode: true,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: true,
    autoAppendOnMultiSelect: true,
  },
  next: {
    label: "Next",
    reserved: true,
    livesInMainList: true,
    numbered: false,
    activatesInputMode: false,
    blocksMultiToggle: true,
    autoSubmitsInMulti: true,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: true,
  },
};

/**
 * Kind-keyed label view. `option` is excluded because its label is
 * per-instance rather than per-kind.
 */
export const LABELS_BY_KIND: { readonly [K in SentinelKind]: string } = {
  other: ROW_INTENT_META.other.label,
  next: ROW_INTENT_META.next.label,
};

/**
 * Reserved-label set for runtime validation. Every sentinel marked `reserved`,
 * plus `"Other"`, which has no runtime row kind at all. `"Other"` is reserved
 * because models are conditioned to author it as an escape-hatch option; the
 * runtime sentinel must stay the only way to reach free text.
 */
export const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>([
  "Other",
  ...SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].reserved).map((k) => ROW_INTENT_META[k].label),
]);

/**
 * Walk the metadata table to decide which sentinel rows a question gets.
 * The two append predicates are mutually exclusive in practice (multi-select
 * versus single-select) but the walker does not enforce that, so adding a third
 * bucket needs only a new flag.
 *
 * Returns kinds in `SENTINEL_KINDS` order. The caller wraps each into a
 * renderable row.
 */
export function sentinelsToAppend(question: QuestionData): SentinelKind[] {
  const out: SentinelKind[] = [];
  for (const kind of SENTINEL_KINDS) {
    const meta = ROW_INTENT_META[kind];
    if (!meta.livesInMainList) continue;
    const appends =
      question.multiSelect === true ? meta.autoAppendOnMultiSelect : meta.autoAppendOnSingleSelect;
    if (appends) out.push(kind);
  }
  return out;
}
