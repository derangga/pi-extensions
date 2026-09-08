import type {
  QuestionAnswer,
  QuestionData,
  QuestionnaireResult,
  UnansweredNote,
} from "../tool/types.js";
import type { WrappingSelectItem } from "./row-intent.js";
import type { QuestionnaireAction } from "./key-router.js";
import { ROW_INTENT_META } from "./row-intent.js";
import { noteForTab, type QuestionnaireState } from "./state.js";
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** Session-lifetime constants. No live-component reads — peripheral values live on canonical state. */
export interface ApplyContext {
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
}

/**
 * Declarative side-effects emitted by `reduce`. The runtime executes them after
 * committing the new state, then asks the props-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
  | { kind: "set_input_buffer"; value: string }
  | { kind: "clear_input_buffer" }
  | { kind: "open_input_editor"; value: string }
  | { kind: "set_notes_value"; value: string }
  | { kind: "set_notes_focused"; focused: boolean }
  | { kind: "forward_notes_keystroke"; data: string }
  /**
   * Tell the session to hide or show its underlying overlay. Emitted by the
   * `toggle_collapsed` action so the runtime can call `OverlayHandle.setHidden(...)`,
   * which lets other overlay-aware consumers (e.g. `pi-station`) see the questionnaire
   * as truly hidden and resume normal chat scroll while the user reads the transcript
   * behind the modal.
   */
  | { kind: "set_overlay_hidden"; hidden: boolean }
  | { kind: "clear_timer" }
  | { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
  state: QuestionnaireState;
  effects: readonly Effect[];
}

function orderedAnswers(
  state: QuestionnaireState,
  questions: readonly QuestionData[],
): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = state.answers.get(i);
    if (a) {
      out.push(a);
    }
  }
  return out;
}

/**
 * Notes on questions with no answer behind them.
 *
 * Walks the questions rather than the map, which gives ask order for free and
 * keeps the global note out: it lives at the `questions.length` pseudo-index in
 * `notesByTab`, and this loop never reaches that far.
 *
 * Reads `state.notesByTab` directly rather than `noteForTab`, because the
 * answer-mirror half of that lookup is unreachable here by construction — an
 * index with no entry in `answers` has no mirror to read.
 */
function unansweredNotesFor(
  state: QuestionnaireState,
  questions: readonly QuestionData[],
): UnansweredNote[] {
  const out: UnansweredNote[] = [];
  for (let i = 0; i < questions.length; i++) {
    if (state.answers.has(i)) {
      continue;
    }
    const question = questions[i];
    const note = state.notesByTab.get(i);
    if (!question || note === undefined || note.length === 0) {
      continue;
    }
    out.push({ questionIndex: i, question: question.question, note });
  }
  return out;
}

function syncMultiSelectFromAnswers(
  answers: ReadonlyMap<number, QuestionAnswer>,
  questions: readonly QuestionData[],
  tab: number,
): ReadonlySet<number> {
  const q = questions[tab];
  if (!q?.multiSelect) {
    return new Set();
  }
  const saved = answers.get(tab);
  const labels = saved?.selected ?? [];
  const indices = new Set<number>();
  for (let i = 0; i < q.options.length; i++) {
    if (labels.includes(q.options[i]!.label)) {
      indices.add(i);
    }
  }
  // The typed row needs nothing here. Its tick is its text, and the text comes
  // back with the tab's draft.
  return indices;
}

function persistMultiSelectAnswer(
  state: QuestionnaireState,
  ctx: ApplyContext,
): ReadonlyMap<number, QuestionAnswer> {
  const q = ctx.questions[state.currentTab];
  if (!q?.multiSelect) {
    return state.answers;
  }
  const selected: string[] = [];
  for (let i = 0; i < q.options.length; i++) {
    if (state.multiSelectChecked.has(i)) {
      selected.push(q.options[i]!.label);
    }
  }
  // Text in the typed row is itself the tick, so a non-blank draft joins the
  // selection. A draft that repeats an option label is not listed twice.
  const typed = customDraftValueFor(state, state.currentTab).trim();
  if (typed.length > 0 && !selected.includes(typed)) {
    selected.push(typed);
  }
  const out = new Map(state.answers);
  if (selected.length === 0) {
    out.delete(state.currentTab);
    return out;
  }
  const pendingNotes = state.notesByTab.get(state.currentTab);
  const entry: QuestionAnswer = {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "multi",
    answer: null,
    selected,
  };
  if (pendingNotes && pendingNotes.length > 0) {
    // SAFETY: notes is an optional string per QuestionAnswer contract; adding when present preserves the shape.
    (entry as QuestionAnswer & { notes: string }).notes = pendingNotes;
  }
  out.set(state.currentTab, entry);
  return out;
}

function customDraftValueFor(state: QuestionnaireState, tab: number): string {
  const draft = state.customDraftsByTab.get(tab);
  if (draft !== undefined) {
    return draft;
  }
  const answer = state.answers.get(tab);
  return answer?.kind === "custom" && isString(answer.answer) ? answer.answer : "";
}

function setCustomDraft(
  state: QuestionnaireState,
  tab: number,
  value: string,
): ReadonlyMap<number, string> {
  const drafts = new Map(state.customDraftsByTab);
  drafts.set(tab, value);
  return drafts;
}

function withoutCustomDraft(state: QuestionnaireState, tab: number): ReadonlyMap<number, string> {
  if (!state.customDraftsByTab.has(tab)) {
    return state.customDraftsByTab;
  }
  const drafts = new Map(state.customDraftsByTab);
  drafts.delete(tab);
  return drafts;
}

function switchTabResult(
  state: QuestionnaireState,
  nextTab: number,
  ctx: ApplyContext,
): ApplyResult {
  const notesValue = noteForTab(state, nextTab);
  const transitioned: QuestionnaireState = {
    ...state,
    currentTab: nextTab,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    submitChoiceIndex: 0,
    multiSelectChecked: syncMultiSelectFromAnswers(state.answers, ctx.questions, nextTab),
    notesDraft: notesValue,
  };
  return {
    state: transitioned,
    effects: [
      { kind: "set_notes_focused", focused: false },
      { kind: "set_notes_value", value: notesValue },
      { kind: "set_input_buffer", value: customDraftValueFor(state, nextTab) },
    ],
  };
}

function doneFor(state: QuestionnaireState, ctx: ApplyContext, cancelled: boolean): ApplyResult {
  // Global note lift: the Submit-tab note lives at the `questions.length` pseudo-index
  // in `notesByTab` — question tabs only occupy 0..questions.length-1, so this can never
  // cross-contaminate a per-question note. Attached regardless of `cancelled` (the
  // reducer is truth; the envelope owns decline presentation), with cancel/submit/confirm
  // sharing this single lift. Conditional spread keeps note-free results byte-identical.
  const globalNote = state.notesByTab.get(ctx.questions.length);
  // Notes on unanswered questions are lifted the same way and for the same
  // reason: they belong to the person who wrote them, not to the answer they
  // never gave, so cancelling must not eat them either.
  const unansweredNotes = unansweredNotesFor(state, ctx.questions);
  const result: QuestionnaireResult = {
    answers: orderedAnswers(state, ctx.questions),
    cancelled,
  };
  if (globalNote && globalNote.length > 0) {
    // SAFETY: globalNote is optional per QuestionnaireResult; present only when non-empty.
    (result as QuestionnaireResult & { globalNote: string }).globalNote = globalNote;
  }
  if (unansweredNotes.length > 0) {
    // SAFETY: unansweredNotes is optional per QuestionnaireResult; present only when non-empty.
    (result as QuestionnaireResult & { unansweredNotes: UnansweredNote[] }).unansweredNotes =
      unansweredNotes;
  }
  return { state, effects: [{ kind: "done", result }] };
}

/**
 * Per-kind handler signature: action payload narrows to the matching union member
 * via `Extract`, so handlers consume fully-typed actions without `as` casts.
 */
type Handler<K extends QuestionnaireAction["kind"]> = (
  state: QuestionnaireState,
  action: Extract<QuestionnaireAction, { kind: K }>,
  ctx: ApplyContext,
) => ApplyResult;

const navHandler: Handler<"nav"> = (state, action, ctx) => {
  const items = ctx.itemsByTab[state.currentTab] ?? [];
  const item = items[action.nextIndex];
  const inputMode = item ? ROW_INTENT_META[item.kind].activatesInputMode : false;
  const customDraftsByTab = state.inputMode
    ? setCustomDraft(state, state.currentTab, action.inputValue)
    : state.customDraftsByTab;
  const next: QuestionnaireState = {
    ...state,
    optionIndex: action.nextIndex,
    inputMode,
    customDraftsByTab,
  };
  // Leaving the typed row: keystrokes never reached the reducer, so this is the
  // first moment it sees the finished text. Re-state the answer here or the
  // Submit review quotes a draft that is several characters out of date.
  if (state.inputMode) {
    next.answers = persistMultiSelectAnswer(next, ctx);
  }
  if (!inputMode) {
    return { state: next, effects: [] };
  }
  return {
    state: next,
    effects: [{ kind: "set_input_buffer", value: customDraftValueFor(next, state.currentTab) }],
  };
};

const inputClearHandler: Handler<"input_clear"> = (state, _action, _ctx) => ({
  state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, "") },
  effects: [{ kind: "clear_input_buffer" }],
});
const inputEditHandler: Handler<"input_edit"> = (state, action, _ctx) => ({
  state,
  effects: [{ kind: "open_input_editor", value: action.value }],
});
const inputReplaceHandler: Handler<"input_replace"> = (state, action, _ctx) => ({
  state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, action.value) },
  effects: [{ kind: "set_input_buffer", value: action.value }],
});

const tabSwitchHandler: Handler<"tab_switch"> = (state, action, ctx) =>
  switchTabResult(state, action.nextTab, ctx);

const confirmHandler: Handler<"confirm"> = (state, action, ctx) => {
  let answer = action.answer;
  if (answer.kind === "option" && answer.answer) {
    const q = ctx.questions[answer.questionIndex];
    const matched = q?.options.find((o) => o.label === answer.answer);
    if (matched?.preview && matched.preview.length > 0) {
      answer = { ...answer, preview: matched.preview };
    }
  }
  const pendingNotes = state.notesByTab.get(answer.questionIndex);
  if (pendingNotes && pendingNotes.length > 0) {
    answer = { ...answer, notes: pendingNotes };
  }
  const answers = new Map(state.answers);
  answers.set(answer.questionIndex, answer);
  const customDraftsByTab =
    answer.kind === "custom"
      ? withoutCustomDraft(state, answer.questionIndex)
      : state.customDraftsByTab;
  const next: QuestionnaireState = {
    ...state,
    answers,
    customDraftsByTab,
  };
  if (action.autoAdvanceTab !== undefined) {
    return switchTabResult(next, action.autoAdvanceTab, ctx);
  }
  return doneFor(next, ctx, false);
};

const toggleHandler: Handler<"toggle"> = (state, action, ctx) => {
  const checked = new Set(state.multiSelectChecked);
  if (checked.has(action.index)) {
    checked.delete(action.index);
  } else {
    checked.add(action.index);
  }
  const intermediate: QuestionnaireState = { ...state, multiSelectChecked: checked };
  const answers = persistMultiSelectAnswer(intermediate, ctx);
  return { state: { ...intermediate, answers }, effects: [] };
};

const multiConfirmHandler: Handler<"multi_confirm"> = (state, action, ctx) => {
  const q = ctx.questions[state.currentTab];
  if (!q) {
    return { state, effects: [] };
  }
  const pendingNotes = state.notesByTab.get(state.currentTab);
  const answers = new Map(state.answers);
  const multiAnswer: QuestionAnswer = {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "multi",
    answer: null,
    selected: action.selected,
  };
  if (pendingNotes && pendingNotes.length > 0) {
    // SAFETY: notes is optional per QuestionAnswer; adding when present preserves the shape.
    (multiAnswer as QuestionAnswer & { notes: string }).notes = pendingNotes;
  }
  answers.set(state.currentTab, multiAnswer);
  const synced: QuestionnaireState = {
    ...state,
    answers,
    multiSelectChecked: syncMultiSelectFromAnswers(answers, ctx.questions, state.currentTab),
  };
  if (action.autoAdvanceTab !== undefined) {
    return switchTabResult(synced, action.autoAdvanceTab, ctx);
  }
  return doneFor(synced, ctx, false);
};

const notesEnterHandler: Handler<"notes_enter"> = (state, _action, _ctx) => {
  const value = noteForTab(state, state.currentTab);
  return {
    state: { ...state, notesVisible: true, notesDraft: value },
    effects: [
      { kind: "set_notes_value", value },
      { kind: "set_notes_focused", focused: true },
    ],
  };
};

const notesExitHandler: Handler<"notes_exit"> = (state, _action, _ctx) => {
  const trimmed = state.notesDraft.trim();
  const notes = new Map(state.notesByTab);
  const answers = new Map(state.answers);
  if (trimmed.length === 0) {
    notes.delete(state.currentTab);
    const prev = answers.get(state.currentTab);
    if (prev?.notes) {
      const stripped = { ...prev };
      const { notes: _removed, ...withoutNotes } = stripped;
      // SAFETY: withoutNotes preserves all required QuestionAnswer fields; notes is optional and removed intentionally.
      answers.set(state.currentTab, withoutNotes as QuestionAnswer);
    }
  } else {
    notes.set(state.currentTab, trimmed);
    const prev = answers.get(state.currentTab);
    if (prev) {
      answers.set(state.currentTab, { ...prev, notes: trimmed });
    }
  }
  return {
    state: { ...state, notesByTab: notes, answers, notesVisible: false },
    effects: [{ kind: "set_notes_focused", focused: false }],
  };
};

const cancelHandler: Handler<"cancel"> = (s, _a, c) => doneFor(s, c, true);
const submitHandler: Handler<"submit"> = (s, _a, c) => doneFor(s, c, false);
const submitNavHandler: Handler<"submit_nav"> = (s, a, _c) => ({
  state: { ...s, submitChoiceIndex: a.nextIndex },
  effects: [],
});
const notesForwardHandler: Handler<"notes_forward"> = (s, a, _c) => ({
  state: s,
  effects: [{ kind: "forward_notes_keystroke", data: a.data }],
});
const toggleCollapsedHandler: Handler<"toggle_collapsed"> = (s, _a, _c) => ({
  state: { ...s, collapsed: !s.collapsed },
  effects: [{ kind: "set_overlay_hidden", hidden: !s.collapsed }],
});
const tickHandler: Handler<"tick"> = (state, action, ctx) => {
  if (state.timerCancelled || state.deadline === undefined) {
    return { state, effects: [] };
  }
  const remaining = state.deadline - action.now;
  if (remaining > 0) {
    return { state: { ...state, remainingMs: remaining }, effects: [] };
  }
  const globalNote = state.notesByTab.get(ctx.questions.length);
  const result: QuestionnaireResult = {
    answers: orderedAnswers(state, ctx.questions),
    cancelled: true,
    error: "timed_out",
  };
  if (globalNote && globalNote.length > 0) {
    // SAFETY: globalNote is optional per QuestionnaireResult; present only when non-empty.
    (result as QuestionnaireResult & { globalNote: string }).globalNote = globalNote;
  }
  return { state, effects: [{ kind: "done", result }] };
};
const ignoreHandler: Handler<"ignore"> = (s, _a, _c) => ({ state: s, effects: [] });

/**
 * Compile-time-exhaustive dispatch table. `{ [K in Kind]: Handler<K> }` requires
 * an entry per union member — adding a new `QuestionnaireAction` variant fails to
 * compile here until a handler is registered, mirroring the `Record<RowKind, …>`
 * pattern used by `ROW_INTENT_META`.
 */
const HANDLERS = {
  nav: navHandler,
  input_clear: inputClearHandler,
  input_edit: inputEditHandler,
  input_replace: inputReplaceHandler,
  tab_switch: tabSwitchHandler,
  confirm: confirmHandler,
  toggle: toggleHandler,
  multi_confirm: multiConfirmHandler,
  cancel: cancelHandler,
  notes_enter: notesEnterHandler,
  notes_exit: notesExitHandler,
  notes_forward: notesForwardHandler,
  submit: submitHandler,
  submit_nav: submitNavHandler,
  toggle_collapsed: toggleCollapsedHandler,
  tick: tickHandler,
  ignore: ignoreHandler,
} satisfies { [K in QuestionnaireAction["kind"]]: Handler<K> };

/**
 * Pure reducer: (state, action, ctx) → (state, Effect[]).
 * Delegates to `HANDLERS` — per-kind handlers above are pure, named, and individually testable.
 * `ignore` is also handled outside the reducer by `handleIgnoreInline` in the runtime fast path.
 */
export function reduce(
  state: QuestionnaireState,
  action: QuestionnaireAction,
  ctx: ApplyContext,
): ApplyResult {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const result = handler(state, action as never, ctx);
  const isHumanKeystroke = action.kind !== "tick" && action.kind !== "toggle_collapsed";
  if (isHumanKeystroke && state.deadline !== undefined && !state.timerCancelled) {
    return {
      state: { ...result.state, timerCancelled: true, remainingMs: undefined },
      effects: [...result.effects, { kind: "clear_timer" }],
    };
  }
  return result;
}
