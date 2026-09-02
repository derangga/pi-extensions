import { expect } from "vitest";
import type { QuestionnaireAction } from "../src/state/key-router.js";
import type { WrappingSelectItem } from "../src/state/row-intent.js";
import type { ApplyContext } from "../src/state/state-reducer.js";
import type { QuestionnaireState } from "../src/state/state.js";
import type { QuestionData } from "../src/tool/types.js";

/**
 * Shared builders for state-layer tests. View-layer fixtures (fake panes,
 * tab components, per-component props) join this file when those components
 * exist; nothing here should import a renderer.
 */

export const itemsRegular: ReadonlyArray<WrappingSelectItem> = [
  { kind: "option", label: "A" },
  { kind: "option", label: "B" },
];

export const itemsWithOther: ReadonlyArray<WrappingSelectItem> = [
  { kind: "option", label: "A" },
  { kind: "option", label: "B" },
  { kind: "other", label: "Type something." },
];

export function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
  return {
    question: over.question ?? "Pick one",
    header: over.header ?? "H",
    options: over.options ?? [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
    // Spread rather than assign: exactOptionalPropertyTypes rejects an explicit
    // undefined on an optional property, and absent is what "not multi-select"
    // actually means here.
    ...(over.multiSelect === undefined ? {} : { multiSelect: over.multiSelect }),
  };
}

export function makeQuestionnaireState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
  return {
    currentTab: over.currentTab ?? 0,
    optionIndex: over.optionIndex ?? 0,
    inputMode: over.inputMode ?? false,
    notesVisible: over.notesVisible ?? false,
    answers: over.answers ?? new Map(),
    multiSelectChecked: over.multiSelectChecked ?? new Set(),
    customDraftsByTab: over.customDraftsByTab ?? new Map(),
    notesByTab: over.notesByTab ?? new Map(),
    submitChoiceIndex: over.submitChoiceIndex ?? 0,
    notesDraft: over.notesDraft ?? "",
    collapsed: over.collapsed ?? false,
  };
}

export function makeApplyContext(over: Partial<ApplyContext> = {}): ApplyContext {
  const questions = over.questions ?? [makeQuestion()];
  return {
    questions,
    itemsByTab: over.itemsByTab ?? questions.map(() => itemsRegular),
  };
}

/**
 * Assert an action's kind and return it narrowed.
 *
 * Replaces the `expect(a.kind).toBe(k); if (a.kind === k) { ... }` pattern.
 * That shape reads as a type guard but behaves as a silent skip: if the kind
 * ever changes, the assertions inside the block stop running and the test still
 * passes. This throws instead, so the narrowing and the assertion are the same
 * act.
 */
export function expectKind<K extends QuestionnaireAction["kind"]>(
  action: QuestionnaireAction,
  kind: K,
): Extract<QuestionnaireAction, { kind: K }> {
  expect(action.kind).toBe(kind);
  return action as Extract<QuestionnaireAction, { kind: K }>;
}
