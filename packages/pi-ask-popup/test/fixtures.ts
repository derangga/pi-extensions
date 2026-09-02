import { stripVTControlCharacters } from "node:util";
import { expect, type Mock, vi } from "vitest";
import { ROW_INTENT_META } from "../src/state/row-intent.js";
import type {
  MultiSelectView,
  MultiSelectViewProps,
} from "../src/view/components/multi-select-view.js";
import type { PreviewPane, PreviewPaneProps } from "../src/view/components/preview/preview-pane.js";
import type { PerTabBindingContext } from "../src/state/selectors/contract.js";
import type { StatefulView } from "../src/view/stateful-view.js";
import type { TabComponents } from "../src/view/tab-components.js";
import type { QuestionnaireAction } from "../src/state/key-router.js";
import type { WrappingSelectItem } from "../src/state/row-intent.js";
import type { ApplyContext } from "../src/state/state-reducer.js";
import type { QuestionnaireState } from "../src/state/state.js";
import type { QuestionData } from "../src/tool/types.js";

/**
 * Shared builders for the package's tests: state-layer values, a theme that
 * renders plain strings, and stand-ins for the components the adapter drives.
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

/**
 * Identity theme. Every styling call returns its text unchanged, so assertions
 * compare plain strings instead of ANSI escapes. Inlined rather than depending
 * on the upstream monorepo's shared test-utils package, which would reintroduce
 * exactly the coupling the fork exists to remove.
 */
export interface MockTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
  strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
  return {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
    ...overrides,
  };
}

export function makeTui(): { requestRender: ReturnType<typeof vi.fn> } {
  return { requestRender: vi.fn<() => void>() };
}

/**
 * Read one rendered line, asserting it exists.
 *
 * noUncheckedIndexedAccess types `lines[0]` as `string | undefined`. Rather
 * than sprinkle `!` through the render assertions, this fails loudly with the
 * index that was missing, which is the more useful failure when a component
 * starts emitting fewer rows than a test expects.
 */
export function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`expected a rendered line at index ${index}, got ${lines.length} line(s)`);
  }
  return line;
}

export interface MultiSelectPropsOverrides {
  optionIndex?: number;
  checkedIndices?: ReadonlySet<number>;
  focused?: boolean;
  nextLabel?: string;
  inputBuffer?: string;
  inputCursorOffset?: number | undefined;
  inputMode?: boolean;
}

/**
 * Build MultiSelectView props the way the real projection does: rows carry
 * `checked` and `active`, and the two sentinel rows sit at
 * `options.length` and `options.length + 1`.
 */
export function makeMultiSelectViewProps(
  question: QuestionData,
  over: MultiSelectPropsOverrides = {},
): MultiSelectViewProps {
  const optionIndex = over.optionIndex ?? 0;
  const checkedIndices = over.checkedIndices ?? new Set<number>();
  const focused = over.focused ?? true;
  const rows = question.options.map((_, i) => ({
    checked: checkedIndices.has(i),
    active: focused && i === optionIndex,
  }));
  const otherActive = focused && optionIndex === question.options.length;
  return {
    rows,
    other: {
      active: otherActive,
      inputMode: (over.inputMode ?? false) && otherActive,
      inputBuffer: over.inputBuffer ?? "",
      inputCursorOffset: over.inputCursorOffset,
    },
    nextActive: focused && optionIndex === question.options.length + 1,
    nextLabel: over.nextLabel ?? ROW_INTENT_META.next.label,
  };
}

/**
 * Strip ANSI styling so assertions compare plain text.
 *
 * Uses the Node builtin rather than a hand-rolled `\x1b\[[0-9;]*m` regex. The
 * regex matched only SGR colour sequences and needed a lint exemption for the
 * control character; the builtin covers the wider VT escape vocabulary and
 * needs neither.
 */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

/** A component that records the props pushed at it and renders nothing. */
export function makeStatefulView<P>(): StatefulView<P> {
  return {
    setProps: vi.fn<(props: P) => void>(),
    render: () => [],
    invalidate: vi.fn<() => void>(),
    handleInput: () => {},
  };
}

/**
 * Read what a fake component was told, without naming its method in an
 * assertion. `expect(view.setProps)` reads a method off an object and hands it
 * around unbound, which the linter rejects and which would break the moment a
 * fake needed real `this`.
 */
export function propsCalls<P>(view: { setProps: (props: P) => void }): P[] {
  return (view.setProps as unknown as Mock<(props: P) => void>).mock.calls.map((call) => call[0]);
}

export function lastProps<P>(view: { setProps: (props: P) => void }): P {
  const calls = propsCalls(view);
  const last = calls.at(-1);
  if (last === undefined) throw new Error("setProps was never called");
  return last;
}

export function invalidateCount(view: { invalidate: () => void }): number {
  return (view.invalidate as unknown as Mock<() => void>).mock.calls.length;
}

/**
 * Stand-in for a `PreviewPane`. `TabComponents.preview` is typed as the
 * concrete class, but the adapter only ever calls `setProps` on it, and
 * building a real one would drag in an option list and a block renderer for no
 * added coverage. Tests that exercise the pane itself use the real thing.
 */
export function makeFakePreviewPane(): PreviewPane {
  return {
    ...makeStatefulView<PreviewPaneProps>(),
    setGlobalLeftWidth: vi.fn<(width: number) => void>(),
    focusedItemRowRange: (_width: number) => [0, 0] as [number, number],
  } as unknown as PreviewPane;
}

/** The same idea for `MultiSelectView`, whose concrete methods the chrome calls. */
export function makeFakeMultiSelectView(
  over: { focusedItemRowRange?: (width: number) => [number, number] } = {},
): MultiSelectView {
  return {
    ...makeStatefulView<MultiSelectViewProps>(),
    focusedItemRowRange:
      over.focusedItemRowRange ?? ((_width: number) => [0, 0] as [number, number]),
    naturalHeight: (_width: number) => 0,
  } as unknown as MultiSelectView;
}

export function makeTabComponents(over: Partial<TabComponents> = {}): TabComponents {
  return {
    optionList: over.optionList ?? makeStatefulView(),
    preview: over.preview ?? makeFakePreviewPane(),
    ...(over.multiSelect === undefined ? {} : { multiSelect: over.multiSelect }),
    bodyHeights: over.bodyHeights ?? (() => ({ current: 0, max: 0 })),
  };
}

/**
 * A per-tick selector context. Tests that need component props build them by
 * running the real projections against one of these, rather than restating the
 * projection logic in a fixture where it can quietly drift from the shipped
 * version.
 */
export function makePerTabContext(over: Partial<PerTabBindingContext> = {}): PerTabBindingContext {
  const questions = over.questions ?? [makeQuestion()];
  return {
    questions,
    itemsByTab: over.itemsByTab ?? questions.map(() => itemsRegular),
    totalQuestions: over.totalQuestions ?? questions.length,
    activeView: over.activeView ?? "options",
    inputBuffer: over.inputBuffer ?? "",
    inputCursorOffset: over.inputCursorOffset ?? 0,
    activePreviewPane: over.activePreviewPane ?? makeFakePreviewPane(),
    tab: over.tab ?? makeTabComponents(),
    i: over.i ?? 0,
  };
}
