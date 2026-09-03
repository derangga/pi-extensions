import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Editor,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, formatKeySpecForDisplay } from "../config.js";
import { formatAnswerScalar } from "../tool/format-answer.js";
import { noteForTab } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPane, PreviewPaneProps } from "./components/preview/preview-pane.js";
import {
  type DialogState,
  HINT_PART_CANCEL,
  HINT_PART_CLEAR,
  HINT_PART_COLLAPSE_TEMPLATE,
  HINT_PART_ENTER,
  HINT_PART_NAV,
  HINT_PART_NEW_LINE,
  HINT_PART_NOTES,
  HINT_PART_NOTES_EDIT,
  HINT_PART_TAB,
  HINT_PART_TOGGLE,
  INCOMPLETE_WARNING_PREFIX,
  KEY_PLACEHOLDER,
  READY_PROMPT,
  REVIEW_HEADING,
} from "./dialog-builder.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";

const NOTES_HEADER = "Notes:";
/**
 * Label for a committed note, shared by the question tab's resting row and the
 * Submit review so the two cannot drift apart. Lowercase where the editor
 * header is capitalised: capitalised means live, lowercase means at rest.
 */
const NOTES_LABEL = "notes:";
const GLOBAL_NOTES_HEADER = "Global note:";
const REVIEW_GLOBAL_HINT = "n to add a note";
const REVIEW_NOTE_LABEL = "Note";

/**
 * A chrome cell that is always exactly one row, clipped to width.
 *
 * The footer row count is an invariant the height math depends on, and pi-tui's
 * `Text` word-wraps: a hint longer than the terminal is wide would silently
 * become two rows, and every tab's height would stop agreeing. Clipping keeps
 * it at one row and lets the tail — the collapse affordance first — fall off
 * the right edge with `…` on a narrow terminal.
 */
class OneLineClippedText implements Component {
  constructor(
    private readonly text: string,
    private readonly paddingLeft: number = 0,
  ) {}

  render(width: number): string[] {
    const pad = " ".repeat(this.paddingLeft);
    const avail = Math.max(0, width - this.paddingLeft);
    return [pad + truncateToWidth(this.text, avail, "…", false)];
  }

  invalidate(): void {}

  handleInput(_data: string): void {}
}

/** Header text for a review row, falling back to a position when the author gave none. */
function tabLabel(header: string | undefined, index: number): string {
  return header !== undefined && header.length > 0 ? header : `Q${index + 1}`;
}

/**
 * What a tab puts in each region of the dialog. Pure: construction-time config
 * is closed over, per-tick state arrives as an argument. The frame equalizes
 * height across tabs from `bodyHeight + footerRowCount`, which is why the row
 * counts below are contracts and not estimates.
 */
export interface TabContentStrategy {
  /** Rendered footer rows. MUST equal what `footerRows()` emits — the residual math reads it. */
  readonly footerRowCount: number;

  /** Rows between the top chrome and the body. */
  headingRows(state: DialogState): Component[];

  /** The body itself. */
  bodyComponent(state: DialogState): Component;

  /** Rendered height of `bodyComponent(state)` at this width. */
  bodyHeight(width: number, state: DialogState): number;

  /** Rows between the body's trailing spacer and the bottom border. */
  midRows(state: DialogState): Component[];

  /** Rows below the bottom border. Rendered count MUST equal `footerRowCount`. */
  footerRows(state: DialogState): Component[];

  /** Where the focused item sits inside the body, or undefined when nothing is focused. */
  focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined;
  /**
   * Rows this strategy spends on a committed note at rest, so the frame can
   * equalize them across tabs. Not measured from `midRows`, because the open
   * notes editor also lives there and its height is an intentional expansion
   * that must stay outside the equalization.
   */
  restingNoteRowCount(state: DialogState): number;
}

/** One line, whatever the note did. See `QuestionTabStrategy.restingNoteRows`. */
function collapseToOneLine(note: string): string {
  return note.replace(/\s*\n\s*/g, " ");
}

export interface QuestionTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  getPreviewPane: () => StatefulView<PreviewPaneProps>;
  tabsByIndex: ReadonlyArray<TabComponents>;
  notesInput: Editor;
  isMulti: boolean;
  getCurrentBodyHeight: (width: number) => number;
  /** Resolved collapse key. Drives whether the footer advertises the shortcut at all. */
  collapseKey: string;
}

export class QuestionTabStrategy implements TabContentStrategy {
  /** Spacer(1) + the clipped hint row. */
  readonly footerRowCount = 2;

  constructor(private readonly config: QuestionTabStrategyConfig) {}

  headingRows(state: DialogState): Component[] {
    const out: Component[] = [];
    const question = this.config.questions[state.currentTab];
    // With several questions the tab bar already shows the header, so the
    // inline badge would say it twice.
    if (!this.config.isMulti && question?.header !== undefined && question.header.length > 0) {
      out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
      out.push(new Spacer(1));
    }
    if (question) {
      out.push(new Text(this.config.theme.bold(question.question), 1, 0));
      out.push(new Spacer(1));
    }
    return out;
  }

  bodyComponent(state: DialogState): Component {
    const question = this.config.questions[state.currentTab];
    const multiSelect = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && multiSelect) return multiSelect;
    return this.config.getPreviewPane();
  }

  bodyHeight(width: number, _state: DialogState): number {
    return this.config.getCurrentBodyHeight(width);
  }

  midRows(state: DialogState): Component[] {
    if (!state.notesVisible) return this.restingNoteRows(state);
    return [
      new Text(this.config.theme.fg("muted", NOTES_HEADER), 1, 0),
      this.config.notesInput,
      new Spacer(1),
    ];
  }

  /**
   * A committed note, shown at rest in the slot the editor vacates.
   *
   * Before this existed a note vanished the moment the editor closed, and
   * walking back to its tab did not bring it back — the only way to see one
   * again was to reopen the editor.
   *
   * One row, always. The editor accepts newlines, and rendering an eight-line
   * note in full would eat a scroll region that `computeScrollStart` centres on
   * the option list. The whole text is one keypress away, and the Submit review
   * shows it complete, where `Text` wraps instead of clipping.
   *
   * The reserved blank row is a `Spacer`, never `Text("")`: pi-tui's `Text`
   * renders no lines at all for whitespace-only content, so an empty `Text`
   * would reserve nothing and the height equalization would quietly do nothing.
   * It carries no placeholder text on purpose. A `Spacer(1)` already sits
   * between the body and this slot, so a second blank line reads as bottom
   * padding rather than as something missing, whereas a dim `notes: —` would
   * put noise on every un-noted tab of every questionnaire.
   */
  restingNoteRows(state: DialogState): Component[] {
    if (this.restingNoteRowCount(state) === 0) return [];
    const note = noteForTab(state, state.currentTab);
    if (note.length === 0) return [new Spacer(1)];
    return [
      new OneLineClippedText(
        this.config.theme.fg("dim", `${NOTES_LABEL} ${collapseToOneLine(note)}`),
        1,
      ),
    ];
  }

  /**
   * One row as soon as any question tab carries a note, zero otherwise.
   *
   * Reserved on every question tab rather than only the noted ones: a row
   * present on one tab and absent on the next would resize the dialog on every
   * Tab press, which is exactly what `spacerRows` exists to prevent. It tracks
   * live state, so clearing the last note gives the row back.
   *
   * Zero while the editor is open. The editor is the note's representation
   * then, and its own height is the intentional expansion.
   */
  restingNoteRowCount(state: DialogState): number {
    if (state.notesVisible) return 0;
    for (let i = 0; i < this.config.questions.length; i++) {
      if (noteForTab(state, i).length > 0) return 1;
    }
    return 0;
  }

  footerRows(state: DialogState): Component[] {
    const question = this.config.questions[state.currentTab];
    return [
      new Spacer(1),
      new OneLineClippedText(
        this.config.theme.fg(
          "dim",
          buildHintText(question, this.config.isMulti, state, this.config.collapseKey),
        ),
        1,
      ),
    ];
  }

  focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined {
    const question = this.config.questions[state.currentTab];
    const multiSelect = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && multiSelect) {
      return multiSelect.focusedItemRowRange(width);
    }
    // SAFETY: getPreviewPane returns a StatefulView<PreviewPaneProps> structurally identical to PreviewPane; cast is to access row range.
    return (this.config.getPreviewPane() as unknown as PreviewPane).focusedItemRowRange(width);
  }
}

export interface SubmitTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  submitPicker: Component | undefined;
  /** The shared notes editor, mounted here while the global note is being written. */
  notesInput: Editor;
}

export class SubmitTabStrategy implements TabContentStrategy {
  /**
   * Spacer(1) + prompt + picker(2) + hint. Without a picker, two spacers stand
   * in so the count is still 5.
   */
  readonly footerRowCount = 5;

  constructor(private readonly config: SubmitTabStrategyConfig) {}

  headingRows(_state: DialogState): Component[] {
    return [
      new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)), 1, 0),
      new Spacer(1),
    ];
  }

  bodyComponent(state: DialogState): Component {
    const c = new Container();
    for (let i = 0; i < this.config.questions.length; i++) {
      const q = this.config.questions[i];
      if (!q) continue;
      const a = state.answers.get(i);
      const note = noteForTab(state, i);
      // A note with no answer still gets an entry. Skipping it, which is what
      // this loop used to do, dropped the note from the review and from the
      // result: the user wrote something and was never told it went nowhere.
      if (!a && note.length === 0) continue;
      c.addChild(new Text(this.config.theme.fg("muted", ` ● ${tabLabel(q.header, i)}`), 1, 0));
      // No arrow row when there is no answer. The absent row is the signal, and
      // the footer already names the question in its incomplete warning, so
      // there is nothing to gain from minting a placeholder to sit in the
      // answer's place.
      if (a) {
        const answerText = formatAnswerScalar(a, "summary");
        c.addChild(
          new Text(
            `   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`,
            1,
            0,
          ),
        );
      }
      if (note.length > 0) {
        // `Text`, not `OneLineClippedText`: the review is where a long note is
        // meant to be read whole, so it wraps and `bodyHeight` measures it.
        c.addChild(new Text(this.config.theme.fg("dim", `     ${NOTES_LABEL} ${note}`), 1, 0));
      }
    }
    // The committed global note appears as a review entry, so pressing `n` has
    // visible effect and the note can be read back before submitting. Hidden
    // while the editor is open: the editor below is seeded with this text, and
    // a copy above it would read as a second, separate note.
    const globalNote = state.notesByTab.get(this.config.questions.length);
    if (!state.notesVisible && globalNote !== undefined && globalNote.length > 0) {
      c.addChild(new Text(this.config.theme.fg("muted", ` ● ${REVIEW_NOTE_LABEL}`), 1, 0));
      c.addChild(
        new Text(
          `   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", globalNote)}`,
          1,
          0,
        ),
      );
    }
    return c;
  }

  bodyHeight(width: number, state: DialogState): number {
    return this.bodyComponent(state).render(width).length;
  }

  midRows(state: DialogState): Component[] {
    // The question tabs' notes editor, mirrored for the global note. The draft
    // itself is reducer-owned; this only renders it.
    if (!state.notesVisible) return [];
    return [
      new Text(this.config.theme.fg("muted", GLOBAL_NOTES_HEADER), 1, 0),
      this.config.notesInput,
      new Spacer(1),
    ];
  }

  footerRows(state: DialogState): Component[] {
    const missing: string[] = [];
    for (let i = 0; i < this.config.questions.length; i++) {
      const q = this.config.questions[i];
      if (q && !state.answers.has(i)) missing.push(tabLabel(q.header, i));
    }
    const promptText =
      missing.length === 0
        ? this.config.theme.fg("muted", READY_PROMPT)
        : this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
    // Clipped, not `Text`, for the same reason as the hint row below it. The
    // incomplete warning is the longest string this footer can produce — the
    // prefix plus every missing header — and it passes 80 columns with four
    // unanswered questions, which would wrap it into a second row and make the
    // rendered count disagree with `footerRowCount`.
    const out: Component[] = [new Spacer(1), new OneLineClippedText(promptText, 1)];
    if (this.config.submitPicker) {
      out.push(this.config.submitPicker);
    } else {
      // Padding for the unwired case, so the rendered count still matches.
      out.push(new Spacer(1));
      out.push(new Spacer(1));
    }
    // The same dim `·`-joined bottom row the question tabs use, so the prompt
    // reads straight into its picker with no hint wedged between them. Always
    // present, so the count stays at 5.
    out.push(new OneLineClippedText(this.config.theme.fg("dim", buildSubmitHintText(state)), 1));
    return out;
  }

  focusedItemRowRange(_width: number, _state: DialogState): [number, number] | undefined {
    return undefined;
  }

  /**
   * Always zero. The global note already appears as a review entry in the body,
   * so a resting row here would show the same note twice. The frame pads this
   * tab instead, which is what keeps it level with the question tabs once one
   * of them reserves a row.
   */
  restingNoteRowCount(_state: DialogState): number {
    return 0;
  }
}

function remainingLabel(state: DialogState): string | undefined {
  if (state.timerCancelled) return undefined;
  const ms = state.remainingMs;
  if (ms === undefined) return undefined;
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return `${secs}s left`;
}

/**
 * The controls hint, in order:
 *   Enter · ↑/↓ [· Space toggle] [· n notes] [· Tab switch] · Esc [· <key> collapse]
 *   [· Shift+Enter newline] [· Ctrl+U clear] [· Ns left]
 *
 * NOTES belongs to the resting core and drops as soon as the notes editor or
 * the custom-answer row has the keyboard. Ctrl+G is Pi's own external-editor
 * shortcut and needs no hint from us; the clear shortcut is appended at the far
 * right only while input mode is active.
 *
 * The collapse part is omitted when the key is `"off"`. Both the key router and
 * the raw terminal listener refuse to collapse in that case, so advertising a
 * key would be a lie.
 */
export function buildHintText(
  question: QuestionData | undefined,
  isMulti: boolean,
  state: DialogState,
  collapseKey: string,
): string {
  const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
  if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
  if (question && !state.notesVisible && !state.inputMode) {
    // "add" is wrong once one exists, and the hint is the only affordance
    // telling a keyboard user the resting row can be reopened at all.
    parts.push(
      noteForTab(state, state.currentTab).length > 0 ? HINT_PART_NOTES_EDIT : HINT_PART_NOTES,
    );
  }
  if (isMulti) parts.push(HINT_PART_TAB);
  parts.push(HINT_PART_CANCEL);
  if (collapseKey !== COLLAPSE_KEY_OFF) {
    parts.push(
      HINT_PART_COLLAPSE_TEMPLATE.replace(KEY_PLACEHOLDER, formatKeySpecForDisplay(collapseKey)),
    );
  }
  if (state.notesVisible || state.inputMode) parts.push(HINT_PART_NEW_LINE);
  if (state.inputMode) parts.push(HINT_PART_CLEAR);
  const rem = remainingLabel(state);
  if (rem) parts.push(rem);
  return parts.join(" · ");
}

/**
 * The submit tab's counterpart. Resting: Enter · ↑/↓ · n to add a note · Esc.
 * With the global-note editor open the note part drops, because the open editor
 * is the affordance, and the newline hint is appended after cancel — the same
 * shape the question tabs take when their notes are open.
 */
export function buildSubmitHintText(state: DialogState): string {
  const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
  if (!state.notesVisible) parts.push(REVIEW_GLOBAL_HINT);
  parts.push(HINT_PART_CANCEL);
  if (state.notesVisible) parts.push(HINT_PART_NEW_LINE);
  const rem = remainingLabel(state);
  if (rem) parts.push(rem);
  return parts.join(" · ");
}
