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
    if (!state.notesVisible) return [];
    return [
      new Text(this.config.theme.fg("muted", NOTES_HEADER), 1, 0),
      this.config.notesInput,
      new Spacer(1),
    ];
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
      const a = state.answers.get(i);
      if (!q || !a) continue;
      const answerText = formatAnswerScalar(a, "summary");
      c.addChild(new Text(this.config.theme.fg("muted", ` ● ${tabLabel(q.header, i)}`), 1, 0));
      c.addChild(
        new Text(
          `   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`,
          1,
          0,
        ),
      );
      if (a.notes !== undefined && a.notes.length > 0) {
        c.addChild(new Text(this.config.theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
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
  if (question && !state.notesVisible && !state.inputMode) parts.push(HINT_PART_NOTES);
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
