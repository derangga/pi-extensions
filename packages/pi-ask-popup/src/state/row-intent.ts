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
export type RowKind = "option" | "other" | "chat" | "next";

/**
 * Sentinel kinds: the protocol-driven rows, as opposed to author-defined
 * `option` rows. The auto-append walker, the reserved-label derivation and
 * `LABELS_BY_KIND` all iterate this list.
 *
 * Order is the append order on every question: options, the free-text row, the
 * chat row, the commit row. The chat row sits before "Next" because it reads
 * as another way out, not as the primary action.
 */
export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = ["other", "chat", "next"];

/**
 * One renderable row. Lives here rather than in the view because it is the
 * protocol shape a row carries, and both the reducer and the key router read it
 * without knowing anything about rendering. The option renderer re-exports this
 * name so view-layer code reads unchanged.
 *
 * `kind` narrows exactly as a hand-written union would: `item.kind === "other"`
 * still discriminates, and a `switch` over it is still exhaustiveness-checked.
 */
export interface WrappingSelectItem {
  kind: RowKind;
  label: string;
  description?: string;
}

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
 *   `Next` row is drawn bare by `MultiSelectView`, which does its own
 *   numbering; the `chat` row keeps its number there too.
 * - `activatesInputMode` — focusing the row flips `state.inputMode`, turning it
 *   into an inline editor. Read by the reducer's `nav` case.
 * - `blocksMultiToggle` — in multi-select, Space and Enter-as-toggle are
 *   suppressed on this row. `Next` and `chat` only.
 * - `autoSubmitsInMulti` — in multi-select, Enter on this row commits the
 *   question. `Next` and `chat` only.
 * - `separatorAbove` — the renderer draws a full-width rule above the row,
 *   setting it off from the answer list. `chat` only.
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
  separatorAbove: boolean;
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
    separatorAbove: false,
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
    separatorAbove: false,
  },
  /**
   * The "Chat about this" row. Selecting it abandons the questionnaire: the
   * dialog closes and the tool result carries a `chatRequested` marker for the
   * question it was picked on, so the model stops and treats the user's next
   * chat message as a clarification of that question. It is a decision, not an
   * answer — no `QuestionAnswer` is minted for it.
   *
   * It is numbered like the rows above it but sits under a full-width rule,
   * because it is not one of the answers: it ends the questionnaire. In
   * multi-select it shares `autoSubmitsInMulti` and `blocksMultiToggle` with
   * `next`, even though the commit it performs closes the dialog rather than
   * advancing a tab.
   */
  chat: {
    label: "Chat about this",
    reserved: true,
    livesInMainList: true,
    numbered: true,
    activatesInputMode: false,
    blocksMultiToggle: true,
    autoSubmitsInMulti: true,
    autoAppendOnSingleSelect: true,
    autoAppendOnMultiSelect: true,
    separatorAbove: true,
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
    separatorAbove: false,
  },
};

/**
 * Kind-keyed label view. `option` is excluded because its label is
 * per-instance rather than per-kind.
 */
export const LABELS_BY_KIND: { readonly [K in SentinelKind]: string } = {
  other: ROW_INTENT_META.other.label,
  chat: ROW_INTENT_META.chat.label,
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
  // A flatMap because the filter and the projection read the same meta entry;
  // two passes would walk SENTINEL_KINDS twice for one set.
  ...SENTINEL_KINDS.flatMap((k) => (ROW_INTENT_META[k].reserved ? [ROW_INTENT_META[k].label] : [])),
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
    if (!meta.livesInMainList) {
      continue;
    }
    const appends =
      question.multiSelect === true ? meta.autoAppendOnMultiSelect : meta.autoAppendOnSingleSelect;
    if (appends) {
      out.push(kind);
    }
  }
  return out;
}
