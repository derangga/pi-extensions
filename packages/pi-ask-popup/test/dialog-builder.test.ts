import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData } from "../src/tool/types.js";
import { TabBar } from "../src/view/components/tab-bar.js";
import {
  buildHintText,
  buildSubmitHintText,
  QuestionTabStrategy,
  SubmitTabStrategy,
} from "../src/view/tab-content-strategy.js";
import { DEFAULT_QUESTIONS, stubComponent, stubPreviewPane, theme } from "./dialog-harness.js";
import { makeQuestionnaireState, makeTabComponents } from "./fixtures.js";

/**
 * `DialogView.render` derives its region sizes from structure rather than
 * measuring: the top border is one row, the tab bar is two, the footer is
 * whatever the strategy says. Every one of those numbers is a claim about a
 * component this file does not own, so each is checked here directly. A
 * component that quietly starts rendering a different number of rows would
 * otherwise show up as a subtly wrong scroll window and nothing else.
 */

describe("the row counts the chrome assumes", () => {
  it("draws the border in exactly one row", () => {
    const border = new DynamicBorder((s) => theme.fg("accent", s));
    expect(border.render(80)).toHaveLength(1);
  });

  it("draws the tab bar in exactly two rows", () => {
    const bar = new TabBar(theme);
    bar.setProps({
      tabs: [
        { label: "H1", active: true, answered: false, noted: false },
        { label: "H2", active: false, answered: false, noted: false },
      ],
      submit: { active: false, allAnswered: false },
    });
    expect(bar.render(80)).toHaveLength(2);
  });
});

/**
 * The invariant the whole height equalizer rests on: a strategy's declared
 * `footerRowCount` has to match what `footerRows()` really renders. Declaring
 * it and emitting something else does not fail anywhere near the mistake — the
 * dialog silently mis-sizes its scroll window and tabs start jumping.
 */
describe("footerRowCount matches the rows actually emitted", () => {
  function renderedFooterRows(rows: { render(width: number): string[] }[], width = 80): number {
    return rows.reduce((total, row) => total + row.render(width).length, 0);
  }

  const questionStrategy = (collapseKey = "ctrl+]") =>
    new QuestionTabStrategy({
      theme,
      questions: DEFAULT_QUESTIONS,
      getPreviewPane: () => stubPreviewPane(["<PREVIEW>"]),
      tabsByIndex: DEFAULT_QUESTIONS.map(() => makeTabComponents()),
      notesInput: stubComponent(["<NOTES_INPUT>"]) as never,
      isMulti: true,
      getCurrentBodyHeight: () => 1,
      collapseKey,
    });

  const submitStrategy = (withPicker: boolean) =>
    new SubmitTabStrategy({
      theme,
      questions: DEFAULT_QUESTIONS,
      submitPicker: withPicker ? stubComponent(["<ROW1>", "<ROW2>"]) : undefined,
      notesInput: stubComponent(["<NOTES_INPUT>"]) as never,
    });

  it.each([
    ["question tab, resting", () => questionStrategy(), makeQuestionnaireState()],
    [
      "question tab, notes open",
      () => questionStrategy(),
      makeQuestionnaireState({ notesVisible: true }),
    ],
    [
      "question tab, collapse shortcut off",
      () => questionStrategy("off"),
      makeQuestionnaireState(),
    ],
    ["submit tab, with a picker", () => submitStrategy(true), makeQuestionnaireState()],
    ["submit tab, without a picker", () => submitStrategy(false), makeQuestionnaireState()],
  ])("holds for %s", (_label, make, state) => {
    const strategy = make();
    expect(renderedFooterRows(strategy.footerRows(state))).toBe(strategy.footerRowCount);
  });

  it("holds at a width far too narrow for the hint to fit", () => {
    // This is the case the clipped one-line cell exists for. pi-tui's `Text`
    // would word-wrap here and quietly make the footer taller than declared.
    const strategy = questionStrategy();
    const state = makeQuestionnaireState();
    for (const width of [4, 10, 20, 40]) {
      expect(renderedFooterRows(strategy.footerRows(state), width)).toBe(strategy.footerRowCount);
    }
  });

  it("holds for the submit tab at a narrow width too", () => {
    const strategy = submitStrategy(true);
    const state = makeQuestionnaireState();
    for (const width of [4, 10, 20, 40]) {
      expect(renderedFooterRows(strategy.footerRows(state), width)).toBe(strategy.footerRowCount);
    }
  });

  it("holds while the incomplete warning names four long headers", () => {
    // The longest string this footer can produce, and it does not need a narrow
    // terminal to overflow: at 80 columns the prefix plus four 16-character
    // headers already passes the edge. Wrapping here would leave the chrome
    // slicing the wrong number of sticky rows and cutting the prompt in half.
    const questions: QuestionData[] = [0, 1, 2, 3].map((i) => ({
      question: `Q${i}?`,
      header: `SixteenCharsHdr${i}`,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    }));
    const strategy = new SubmitTabStrategy({
      theme,
      questions,
      submitPicker: stubComponent(["<ROW1>", "<ROW2>"]),
      notesInput: stubComponent(["<NOTES_INPUT>"]) as never,
    });
    const state = makeQuestionnaireState({ currentTab: questions.length });
    for (const width of [60, 80, 100, 120]) {
      expect(renderedFooterRows(strategy.footerRows(state), width)).toBe(strategy.footerRowCount);
    }
  });
});

describe("buildHintText", () => {
  const question = DEFAULT_QUESTIONS[0] as (typeof DEFAULT_QUESTIONS)[number];

  it("names the collapse key it was given", () => {
    expect(buildHintText(question, false, makeQuestionnaireState(), "alt+o")).toContain(
      "Alt+O to collapse",
    );
  });

  it("says nothing about collapsing when the shortcut is off", () => {
    expect(buildHintText(question, false, makeQuestionnaireState(), "off")).not.toContain(
      "to collapse",
    );
  });

  it("offers notes only while neither editor has the keyboard", () => {
    const resting = buildHintText(question, false, makeQuestionnaireState(), "ctrl+]");
    expect(resting).toContain("n to add notes");
    for (const state of [{ notesVisible: true }, { inputMode: true }]) {
      expect(buildHintText(question, false, makeQuestionnaireState(state), "ctrl+]")).not.toContain(
        "n to add notes",
      );
    }
  });

  it("offers the toggle only on a multi-select question", () => {
    const state = makeQuestionnaireState();
    expect(buildHintText(question, false, state, "ctrl+]")).not.toContain("Space to toggle");
    expect(buildHintText({ ...question, multiSelect: true }, false, state, "ctrl+]")).toContain(
      "Space to toggle",
    );
  });

  it("offers tab switching only when there is more than one question", () => {
    const state = makeQuestionnaireState();
    expect(buildHintText(question, false, state, "ctrl+]")).not.toContain("Tab to switch");
    expect(buildHintText(question, true, state, "ctrl+]")).toContain("Tab to switch");
  });

  it("adds the clear shortcut only while input mode is capturing text", () => {
    expect(
      buildHintText(question, false, makeQuestionnaireState({ inputMode: true }), "ctrl+]"),
    ).toContain("Ctrl+U to clear");
    expect(
      buildHintText(question, false, makeQuestionnaireState({ notesVisible: true }), "ctrl+]"),
    ).not.toContain("Ctrl+U to clear");
  });

  it("drops every question-specific part when there is no question", () => {
    const hint = buildHintText(undefined, false, makeQuestionnaireState(), "ctrl+]");
    expect(hint).not.toContain("n to add notes");
    expect(hint).not.toContain("Space to toggle");
    expect(hint).toContain("Esc to cancel");
  });
});

describe("buildSubmitHintText", () => {
  it("offers the note while the editor is closed", () => {
    const hint = buildSubmitHintText(makeQuestionnaireState());
    expect(hint).toContain("n to add a note");
    expect(hint).not.toContain("Shift+Enter");
  });

  it("swaps it for the newline hint once the editor is open", () => {
    const hint = buildSubmitHintText(makeQuestionnaireState({ notesVisible: true }));
    expect(hint).not.toContain("n to add a note");
    expect(hint).toContain("Shift+Enter");
  });
});

/**
 * The review body's height is invisible in a full dialog render: the residual
 * spacer absorbs body-height changes to keep tabs the same height, so a stray
 * row here shifts content without changing the total. Asserting on the
 * strategy directly is the only place the difference shows.
 */
describe("the review body only lists what has been answered", () => {
  const questions: QuestionData[] = [0, 1].map((i) => ({
    question: `Q${i}?`,
    header: `H${i}`,
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  }));

  const strategy = new SubmitTabStrategy({
    theme,
    questions,
    submitPicker: stubComponent(["<ROW1>", "<ROW2>"]),
    notesInput: stubComponent(["<NOTES_INPUT>"]) as never,
  });

  const answerFor = (i: number): QuestionAnswer => ({
    questionIndex: i,
    question: `Q${i}?`,
    kind: "option",
    answer: "A",
  });

  it("spends two rows per answered question and nothing on the rest", () => {
    for (const answered of [0, 1, 2]) {
      const answers = new Map<number, QuestionAnswer>(
        Array.from({ length: answered }, (_v, i) => [i, answerFor(i)]),
      );
      const state = makeQuestionnaireState({ currentTab: questions.length, answers });
      expect(strategy.bodyComponent(state).render(80)).toHaveLength(answered * 2);
      expect(strategy.bodyHeight(80, state)).toBe(answered * 2);
    }
  });

  it("adds a third row for a question that carries a note", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { ...answerFor(0), notes: "watch the rate limit" }],
    ]);
    const state = makeQuestionnaireState({ currentTab: questions.length, answers });
    expect(strategy.bodyHeight(80, state)).toBe(3);
  });

  it("adds two rows for a committed global note, and drops them while it is being edited", () => {
    const answers = new Map<number, QuestionAnswer>([[0, answerFor(0)]]);
    const notesByTab = new Map([[questions.length, "Ship behind a flag"]]);
    const base = { currentTab: questions.length, answers, notesByTab };
    expect(strategy.bodyHeight(80, makeQuestionnaireState(base))).toBe(4);
    expect(strategy.bodyHeight(80, makeQuestionnaireState({ ...base, notesVisible: true }))).toBe(
      2,
    );
  });
});
