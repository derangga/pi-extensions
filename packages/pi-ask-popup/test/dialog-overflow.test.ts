import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData } from "../src/tool/types.js";
import { SUBMIT_LABEL } from "../src/view/components/submit-picker.js";
import {
  type DialogState,
  HINT_MULTI,
  HINT_PART_CANCEL,
  HINT_PART_ENTER,
  HINT_PART_NEW_LINE,
  HINT_PART_NOTES,
  HINT_SINGLE,
  READY_PROMPT,
  REVIEW_HEADING,
} from "../src/view/dialog-builder.js";
import {
  type MakeConfigOverrides,
  renderDialog,
  stubMultiSelect,
  stubPreviewPane,
  submitPickerFor,
} from "./dialog-harness.js";
import { lineAt, makeQuestionnaireState, stripAnsi } from "./fixtures.js";

/**
 * The dialog's overflow behavior: what happens once the assembled content is
 * taller than the terminal. Three regions — a sticky heading, a scrolling
 * middle and a sticky footer — with arrows marking what the window is hiding.
 *
 * The row arithmetic these tests pin down, for the multi-question default:
 *   topFixed    = border(1) + tabBar(2) + spacer(1) = 4
 *   bottomFixed = border(1) + footerRowCount        = 3 on a question tab,
 *                                                     6 on the submit tab
 */

const trimmed = (line: string) => stripAnsi(line).trim();

/** Rows whose entire visible content is one arrow. The hint line also says "↑/↓", so a plain substring search would find it. */
function indicatorRows(lines: readonly string[], glyph: string): number[] {
  return lines.flatMap((line, i) => (trimmed(line) === glyph ? [i] : []));
}

function trailingBlanks(lines: readonly string[]): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && trimmed(lineAt(lines, i)) === ""; i--) n++;
  return n;
}

const OVERFLOWING = {
  getTerminalRows: () => 14,
  getBodyHeight: () => 20,
  getCurrentBodyHeight: () => 10,
};

describe("dialog overflow — a terminal with room to spare", () => {
  it("keeps the residual padding, since nothing is being scrolled away", () => {
    // (6 + 5) - (1 + 2) = 8 padding rows below the hint.
    const lines = renderDialog({
      getTerminalRows: () => 50,
      getBodyHeight: () => 6,
      getCurrentBodyHeight: () => 1,
    });
    const hintIdx = lines.findIndex((l) => l.includes(HINT_PART_ENTER));
    expect(hintIdx).toBeGreaterThan(0);
    const tail = lines.slice(hintIdx + 1);
    expect(tail).toHaveLength(8);
    expect(tail.every((l) => l.trim() === "")).toBe(true);
  });

  it("emits no scroll indicators at all", () => {
    const lines = renderDialog({
      getTerminalRows: () => 50,
      getBodyHeight: () => 1,
      getCurrentBodyHeight: () => 1,
    });
    expect(indicatorRows(lines, "↑")).toEqual([]);
    expect(indicatorRows(lines, "↓")).toEqual([]);
    expect(indicatorRows(lines, "↕")).toEqual([]);
  });
});

describe("dialog overflow — staying inside the terminal", () => {
  it.each([5, 7, 10, 15, 20, 24])("fits a %d-row terminal", (termRows) => {
    const lines = renderDialog({ ...OVERFLOWING, getTerminalRows: () => termRows });
    expect(lines.length).toBeLessThanOrEqual(termRows);
  });

  it("never emits a line wider than the width it was asked for", () => {
    for (const termRows of [10, 15, 24]) {
      for (const width of [60, 80, 120]) {
        const lines = renderDialog({ ...OVERFLOWING, getTerminalRows: () => termRows }, width);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("dialog overflow — the three regions", () => {
  it("keeps the top border stuck to the top", () => {
    expect(lineAt(renderDialog(OVERFLOWING), 0)).toMatch(/─/);
  });

  it("keeps the footer hint stuck to the bottom", () => {
    expect(renderDialog(OVERFLOWING).join("\n")).toContain(HINT_PART_NOTES);
  });

  it("has no tab bar to keep sticky in single-question mode", () => {
    const joined = renderDialog({
      questions: [
        { question: "only?", header: "Only", options: [{ label: "yes", description: "" }] },
      ],
      isMulti: false,
      getTerminalRows: () => 10,
      getBodyHeight: () => 10,
      getCurrentBodyHeight: () => 5,
    }).join("\n");
    expect(joined).not.toContain("<TABBAR>");
    expect(joined).toContain(HINT_SINGLE);
  });
});

describe("dialog overflow — a terminal too small for any body", () => {
  it("shows exactly the chrome when the terminal is chrome-height", () => {
    // topFixed 4 + bottomFixed 3 = 7.
    const lines = renderDialog({ ...OVERFLOWING, getTerminalRows: () => 7 });
    expect(lines).toHaveLength(7);
    expect(lineAt(lines, 0)).toMatch(/─/);
    expect(lines.join("\n")).toContain(HINT_PART_NOTES);
  });

  it("clips the chrome itself when even that will not fit", () => {
    const lines = renderDialog({ ...OVERFLOWING, getTerminalRows: () => 5 });
    expect(lines).toHaveLength(5);
  });
});

describe("dialog overflow — which arrows appear", () => {
  const tallBody = (rowRange?: (w: number) => [number, number]) => ({
    ...OVERFLOWING,
    previewPane: stubPreviewPane(Array<string>(20).fill("<LINE>"), rowRange),
  });

  it("combines both arrows into ↕ when the window is a single row", () => {
    // termRows 8 leaves availableMiddle = 8 - 4 - 3 = 1. Writing ↑ and then ↓
    // into that one row would leave only the ↓, hiding the fact that there is
    // anything above it.
    const lines = renderDialog({ ...tallBody(), getTerminalRows: () => 8 });
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(trimmed(lineAt(lines, 4))).toBe("↕");
    expect(indicatorRows(lines, "↑")).toEqual([]);
    expect(indicatorRows(lines, "↓")).toEqual([]);
  });

  it("marks both edges separately when the window has room for two", () => {
    // availableMiddle = 14 - 4 - 3 = 7, so the arrows land at rows 4 and 10.
    const lines = renderDialog(tallBody((_w) => [5, 8]));
    expect(trimmed(lineAt(lines, 4))).toBe("↑");
    expect(trimmed(lineAt(lines, 10))).toBe("↓");
    expect(indicatorRows(lines, "↕")).toEqual([]);
  });

  it("marks only the bottom when the focus is already at the top", () => {
    const lines = renderDialog(tallBody());
    expect(indicatorRows(lines, "↑")).toEqual([]);
    expect(indicatorRows(lines, "↓")).not.toEqual([]);
    expect(indicatorRows(lines, "↕")).toEqual([]);
  });

  it("marks only the top when the focus is on the last row", () => {
    const lines = renderDialog({
      getTerminalRows: () => 14,
      getBodyHeight: () => 30,
      getCurrentBodyHeight: () => 30,
      previewPane: stubPreviewPane(Array<string>(30).fill("<LINE>"), (_w) => [29, 30]),
    });
    expect(indicatorRows(lines, "↑")).not.toEqual([]);
    expect(indicatorRows(lines, "↓")).toEqual([]);
    expect(indicatorRows(lines, "↕")).toEqual([]);
    // Centering on the last row would put the window's ideal start past the end
    // of the content; it has to be pulled back so the window stays full.
    expect(lines).toHaveLength(14);
    expect(lines.slice(5, 10).every((l) => l.includes("<LINE>"))).toBe(true);
  });
});

describe("dialog overflow — where the window lands", () => {
  it("centers a multi-row focused item in the window", () => {
    const lines = renderDialog({
      ...OVERFLOWING,
      previewPane: stubPreviewPane(Array<string>(20).fill("<LINE>"), (_w) => [5, 8]),
    });
    expect(lines.slice(4, 9).some((l) => l.includes("<LINE>"))).toBe(true);
  });

  it("falls back to anchoring at the top when the focused item is taller than the window", () => {
    const lines = renderDialog({
      ...OVERFLOWING,
      previewPane: stubPreviewPane(Array<string>(20).fill("<LINE>"), (_w) => [2, 8]),
    });
    expect(lines.length).toBeLessThanOrEqual(14);
  });

  it("anchors at the top on the submit tab, which has nothing focused", () => {
    const state = makeQuestionnaireState({ currentTab: 2, answers: SUBMIT_ANSWERS });
    const joined = renderDialog({
      state,
      submitPicker: submitPickerFor(state),
      getTerminalRows: () => 14,
      getBodyHeight: () => 6,
    }).join("\n");
    expect(joined).toContain(REVIEW_HEADING);
  });
});

const SUBMIT_ANSWERS = new Map<number, QuestionAnswer>([
  [0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
  [1, { questionIndex: 1, question: "Q2?", kind: "option", answer: "X" }],
]);

describe("dialog overflow — notes on a multi-select tab", () => {
  const multiQuestion: QuestionData = {
    question: "Areas",
    header: "Areas",
    multiSelect: true,
    options: [
      { label: "FE", description: "f" },
      { label: "BE", description: "b" },
    ],
  };

  it("grows by exactly the editor's three rows and leaves the padding alone", () => {
    // The point of the invariant: midRows may grow, but footerRowCount does
    // not, so the residual math that equalizes tab heights stays correct.
    const common: MakeConfigOverrides = {
      questions: [multiQuestion],
      isMulti: false,
      multiSelectByTab: [stubMultiSelect(["<MULTI>"])],
      getTerminalRows: () => 50,
      getBodyHeight: () => 8,
      getCurrentBodyHeight: () => 4,
    };
    const closed = renderDialog({ ...common, state: makeQuestionnaireState() });
    const open = renderDialog({
      ...common,
      state: makeQuestionnaireState({ notesVisible: true }),
    });
    expect(open.length - closed.length).toBe(3);
    expect(trailingBlanks(open)).toBe(trailingBlanks(closed));
  });

  it("keeps the border and the cancel hint sticky while overflowing with notes open", () => {
    // HINT_MULTI is not a substring here: a multi-select tab wedges the toggle
    // hint between navigate and notes, and notes drops while the editor is open.
    const lines = renderDialog({
      questions: [multiQuestion],
      isMulti: false,
      state: makeQuestionnaireState({ notesVisible: true }),
      multiSelectByTab: [stubMultiSelect(Array<string>(10).fill("<MULTI>"))],
      getTerminalRows: () => 10,
      getBodyHeight: () => 20,
      getCurrentBodyHeight: () => 20,
    });
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lineAt(lines, 0)).toMatch(/─/);
    expect(lines.join("\n")).toContain(HINT_PART_CANCEL);
    expect(lines.join("\n")).not.toContain(HINT_MULTI);
  });
});

describe("dialog overflow — notes on the submit tab", () => {
  function submitState(over: Partial<DialogState> = {}): DialogState {
    return makeQuestionnaireState({ currentTab: 2, answers: SUBMIT_ANSWERS, ...over });
  }

  function renderSubmit(state: DialogState, over: MakeConfigOverrides = {}, width = 80): string[] {
    return renderDialog(
      {
        state,
        submitPicker: submitPickerFor(state),
        getTerminalRows: () => 50,
        getBodyHeight: () => 8,
        ...over,
      },
      width,
    );
  }

  it("grows by the editor's three rows, and swaps the note hint for the newline hint", () => {
    const closed = renderSubmit(submitState());
    const open = renderSubmit(submitState({ notesVisible: true }));
    expect(open.length - closed.length).toBe(3);
    expect(open.join("\n")).toContain("Global note:");
    expect(open.join("\n")).toContain("<NOTES_INPUT>");
    expect(closed.join("\n")).not.toContain("<NOTES_INPUT>");
    expect(closed.join("\n")).toContain("n to add a note");
    expect(open.join("\n")).not.toContain("n to add a note");
    expect(open.join("\n")).toContain(HINT_PART_NEW_LINE);
    expect(trailingBlanks(open)).toBe(trailingBlanks(closed));
  });

  it("keeps the border and the picker sticky while overflowing", () => {
    const lines = renderSubmit(submitState({ notesVisible: true }), {
      getTerminalRows: () => 12,
      getBodyHeight: () => 20,
    });
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lineAt(lines, 0)).toMatch(/─/);
    expect(lines.join("\n")).toContain(SUBMIT_LABEL);
  });

  it("clips the hint to one row rather than wrapping it, at any width", () => {
    // A wrapped hint would make the submit footer 6 rows instead of 5 and
    // desync the cross-tab height equalizer, so the height must not move with
    // width once every footer row fits on one line.
    const lengths = new Set(
      [40, 60, 80, 120].map((w) => renderSubmit(submitState(), {}, w).length),
    );
    expect(lengths.size).toBe(1);

    const narrow = renderSubmit(submitState(), {}, 10);
    const hintRows = narrow.filter((l) => trimmed(l).startsWith("Enter to"));
    expect(hintRows).toHaveLength(1);
    expect(visibleWidth(lineAt(hintRows, 0))).toBeLessThanOrEqual(10);
  });

  it("puts the hint below the picker, so the prompt reads into its options", () => {
    const lines = renderSubmit(submitState()).map(stripAnsi);
    const promptRow = lines.findIndex((l) => l.includes(READY_PROMPT));
    const submitRow = lines.findIndex((l) => l.includes(SUBMIT_LABEL));
    const hintRow = lines.findIndex((l) => l.includes("n to add a note"));
    expect(promptRow).toBeGreaterThanOrEqual(0);
    expect(submitRow).toBe(promptRow + 1);
    expect(hintRow).toBeGreaterThan(submitRow);
  });

  it("reviews a committed global note, and hides it while the editor holds the same text", () => {
    // The committed note lives at the pseudo-index past the last question.
    const note = () => new Map([[2, "Ship behind a feature flag"]]);
    const closed = renderSubmit(submitState({ notesByTab: note() })).join("\n");
    expect(closed).toContain("● Note");
    expect(closed).toContain("Ship behind a feature flag");
    const open = renderSubmit(submitState({ notesByTab: note(), notesVisible: true })).join("\n");
    expect(open).not.toContain("● Note");
  });
});
