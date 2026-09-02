import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData } from "../src/tool/types.js";
import { CANCEL_LABEL, SUBMIT_LABEL } from "../src/view/components/submit-picker.js";
import {
  type DialogState,
  HINT_MULTI,
  HINT_PART_CLEAR,
  HINT_PART_COLLAPSE,
  HINT_PART_ENTER,
  HINT_PART_NEW_LINE,
  HINT_PART_NOTES,
  HINT_PART_TOGGLE,
  HINT_SINGLE,
  INCOMPLETE_WARNING_PREFIX,
  READY_PROMPT,
  REVIEW_HEADING,
} from "../src/view/dialog-builder.js";
import {
  DEFAULT_QUESTIONS,
  makeConfig,
  makeDialog,
  MULTI_QUESTION,
  multiSelectFor,
  renderDialog,
  renderJoined,
  stubPreviewPane,
  submitPickerFor,
} from "./dialog-harness.js";
import { makeQuestionnaireState } from "./fixtures.js";

describe("dialog chrome — single-question mode", () => {
  const soloQuestions: QuestionData[] = [
    {
      question: "only?",
      header: "H-only",
      options: [
        { label: "yes", description: "y" },
        { label: "no", description: "n" },
      ],
    },
  ];

  it("leaves out the tab bar", () => {
    const joined = renderJoined({ questions: soloQuestions, isMulti: false });
    expect(joined).not.toContain("<TABBAR>");
    expect(joined).toContain("<PREVIEW>");
    expect(joined).toContain(HINT_SINGLE);
  });

  it("shows the header as a badge in the body, since no tab bar carries it", () => {
    expect(renderJoined({ questions: soloQuestions, isMulti: false })).toContain(" H-only ");
  });
});

describe("dialog chrome — a question tab", () => {
  it("shows the tab bar, the body and the notes affordance", () => {
    const joined = renderJoined();
    expect(joined).toContain("<TABBAR>");
    expect(joined).toContain("<PREVIEW>");
    expect(joined).toContain(HINT_PART_NOTES);
  });

  it("drops the inline header badge once the tab bar is showing the header", () => {
    const lines = renderDialog();
    const duplicated = lines.some((l) => l.includes(" H1 ") && !l.includes("<TABBAR>"));
    expect(duplicated).toBe(false);
  });

  it("advertises Space to toggle only on a multi-select question", () => {
    const state = makeQuestionnaireState();
    const questions = [MULTI_QUESTION, DEFAULT_QUESTIONS[1] as QuestionData];
    const joined = renderJoined(
      {
        questions,
        state,
        multiSelectByTab: [multiSelectFor(MULTI_QUESTION, state, questions), undefined],
        getBodyHeight: () => 4,
      },
      120,
    );
    expect(joined).toContain(HINT_PART_TOGGLE);
    expect(renderJoined({}, 120)).not.toContain(HINT_PART_TOGGLE);
  });

  it("offers notes on an already-answered question too", () => {
    const answer: QuestionAnswer = {
      questionIndex: 0,
      question: "Q1?",
      kind: "option",
      answer: "A",
    };
    const joined = renderJoined({
      state: makeQuestionnaireState({ answers: new Map([[0, answer]]) }),
    });
    expect(joined).toContain(HINT_PART_NOTES);
  });

  it("names the configured collapse key rather than the default", () => {
    const joined = renderJoined({ collapseKey: "alt+o" }, 160);
    expect(joined).toContain("Alt+O to collapse");
    expect(joined).not.toContain("Ctrl+]");
  });

  it("says nothing about collapsing when the shortcut is off", () => {
    // Advertising a key that neither the router nor the terminal listener honors
    // would be a lie the user cannot debug.
    const joined = renderJoined({ collapseKey: "off" }, 160);
    expect(joined).not.toContain("to collapse");
    expect(joined).toContain(HINT_PART_ENTER);
    expect(joined).toContain("Esc to cancel");
  });

  it("swaps notes for the editing shortcuts while the custom row captures text", () => {
    const joined = renderJoined({ state: makeQuestionnaireState({ inputMode: true }) }, 160);
    expect(joined).toContain(HINT_PART_ENTER);
    expect(joined).toContain(HINT_PART_NEW_LINE);
    expect(joined).toContain(HINT_PART_CLEAR);
    expect(joined).not.toContain(HINT_PART_NOTES);
    // Order matters: the context-specific parts sit to the right of the resting
    // core, so a narrow terminal clips them first.
    expect(joined.indexOf(HINT_PART_NEW_LINE)).toBeGreaterThan(joined.indexOf(HINT_PART_COLLAPSE));
    expect(joined.indexOf(HINT_PART_CLEAR)).toBeGreaterThan(joined.indexOf(HINT_PART_NEW_LINE));
  });

  it("mounts the notes editor below the body when notes are open", () => {
    const hidden = makeDialog(makeConfig()).render(160);
    const visible = makeDialog(
      makeConfig({ state: makeQuestionnaireState({ notesVisible: true }) }),
    ).render(160);
    expect(visible.length).toBeGreaterThan(hidden.length);
    expect(visible.join("\n")).toContain("<NOTES_INPUT>");
    expect(visible.join("\n")).toContain(HINT_PART_NEW_LINE);
    expect(hidden.join("\n")).not.toContain("<NOTES_INPUT>");
  });

  it("puts checkboxes where the preview would be on a multi-select question", () => {
    const state = makeQuestionnaireState({ optionIndex: 1, multiSelectChecked: new Set([0]) });
    const questions = [MULTI_QUESTION, DEFAULT_QUESTIONS[1] as QuestionData];
    const joined = renderJoined({
      questions,
      state,
      multiSelectByTab: [multiSelectFor(MULTI_QUESTION, state, questions), undefined],
      getBodyHeight: () => 4,
    });
    expect(joined).toContain("[✔]");
    expect(joined).toContain("[ ]");
    expect(joined).not.toContain("<PREVIEW>");
  });
});

describe("dialog chrome — the submit tab", () => {
  const answers = new Map<number, QuestionAnswer>([
    [0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
    [1, { questionIndex: 1, question: "Q2?", kind: "multi", answer: null, selected: ["X", "Y"] }],
  ]);

  function submitState(over: Partial<DialogState> = {}): DialogState {
    return makeQuestionnaireState({ currentTab: 2, answers, ...over });
  }

  function renderSubmit(over: Partial<DialogState> = {}, focused = true): string {
    const state = submitState(over);
    return renderJoined({
      state,
      submitPicker: submitPickerFor(state, focused),
      getBodyHeight: () => 6,
    });
  }

  it("heads the tab with the review title", () => {
    expect(renderSubmit()).toContain(REVIEW_HEADING);
  });

  it("summarizes each answered question", () => {
    const joined = renderSubmit();
    expect(joined).toContain("● H1");
    expect(joined).toContain("→");
    expect(joined).toContain("A");
    expect(joined).toContain("● H2");
    expect(joined).toContain("X, Y");
  });

  it("leaves unanswered questions out of the summary rather than marking them", () => {
    const partial = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
    ]);
    const joined = renderSubmit({ answers: partial }, false);
    expect(joined).toContain("● H1");
    expect(joined).not.toContain("● H2");
    expect(joined).not.toContain("✖");
  });

  it("asks for confirmation once every question is answered", () => {
    expect(renderSubmit()).toContain(READY_PROMPT);
  });

  it("names what is still missing instead, when something is", () => {
    const partial = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
    ]);
    const joined = renderSubmit({ answers: partial }, false);
    expect(joined).toContain(INCOMPLETE_WARNING_PREFIX);
    expect(joined).toContain("H2");
    expect(joined).not.toContain(READY_PROMPT);
  });

  it("renders both picker rows", () => {
    const joined = renderSubmit();
    expect(joined).toContain(SUBMIT_LABEL);
    expect(joined).toContain(CANCEL_LABEL);
  });

  it("moves the pointer with the selected row", () => {
    const first = renderSubmit({ submitChoiceIndex: 0 }).split("\n");
    expect(first.find((l) => l.includes(SUBMIT_LABEL))).toContain("❯");
    expect(first.find((l) => l.includes(CANCEL_LABEL))).not.toContain("❯");

    const second = renderSubmit({ submitChoiceIndex: 1 }).split("\n");
    expect(second.find((l) => l.includes(SUBMIT_LABEL))).not.toContain("❯");
    expect(second.find((l) => l.includes(CANCEL_LABEL))).toContain("❯");
  });

  it("leaves the submit row enabled even while answers are missing", () => {
    // Submitting an incomplete questionnaire is allowed; the warning says so
    // without the row going dead.
    const joined = renderSubmit({
      answers: new Map([[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }]]),
    });
    const submitLine = joined.split("\n").find((l) => l.includes(SUBMIT_LABEL));
    expect(submitLine).not.toMatch(/<dim>/i);
  });

  it("does not carry the question tabs' hint line", () => {
    expect(renderSubmit()).not.toContain(HINT_MULTI);
  });

  it.each<[string, QuestionData[] | undefined]>([
    ["default headers", undefined],
    [
      "single-character headers",
      [
        {
          question: "Q1?",
          header: "1",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
        {
          question: "Q2?",
          header: "2",
          options: [
            { label: "X", description: "x" },
            { label: "Y", description: "y" },
          ],
        },
      ],
    ],
    [
      "headers of differing width",
      [
        {
          question: "Q1?",
          header: "1",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
        {
          question: "Q2?",
          header: "H2",
          options: [
            { label: "X", description: "x" },
            { label: "Y", description: "y" },
          ],
        },
      ],
    ],
  ])("stays the same height as a question tab with %s", (_label, questions) => {
    // The whole point of footerRowCount and the residual spacer: reaching review
    // must not make the dialog jump.
    const state = submitState();
    const submit = makeDialog(
      makeConfig({
        ...(questions ? { questions } : {}),
        state,
        submitPicker: submitPickerFor(state),
        getBodyHeight: () => 6,
      }),
    ).render(120);
    const question = makeDialog(
      makeConfig({
        ...(questions ? { questions } : {}),
        state: submitState({ currentTab: 0 }),
        getBodyHeight: () => 6,
      }),
    ).render(120);
    expect(submit).toHaveLength(question.length);
  });
});

describe("dialog chrome — setProps", () => {
  it("renders whichever pane was last pushed at it", () => {
    const paneA = stubPreviewPane(["<PANE_A>"]);
    const paneB = stubPreviewPane(["<PANE_B>"]);
    const parts = makeConfig({ previewPane: paneA });
    const dialog = makeDialog(parts);
    expect(dialog.render(80).join("\n")).toContain("<PANE_A>");
    dialog.setProps({ state: parts.initialProps.state, activePreviewPane: paneB });
    const after = dialog.render(80).join("\n");
    expect(after).toContain("<PANE_B>");
    expect(after).not.toContain("<PANE_A>");
  });
});

describe("dialog chrome — width safety", () => {
  it("never emits a line wider than the width it was asked for", () => {
    for (const width of [60, 80, 120]) {
      for (const currentTab of [0, 1, 2]) {
        const lines = renderDialog(
          {
            state: makeQuestionnaireState({
              currentTab,
              notesVisible: currentTab === 0,
              answers: new Map([
                [0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
              ]),
            }),
          },
          width,
        );
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("dialog chrome — residual padding", () => {
  const tall = { getTerminalRows: () => 200 } as const;

  it("grows with the worst-case body height while the current body stays put", () => {
    const short = makeDialog(
      makeConfig({ ...tall, getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 }),
    ).render(80);
    const talls = makeDialog(
      makeConfig({ ...tall, getBodyHeight: () => 20, getCurrentBodyHeight: () => 1 }),
    ).render(80);
    expect(talls.length - short.length).toBe(15);
  });

  it("puts the padding below the hint line, at the very bottom", () => {
    // (getBodyHeight + maxFooterRowCount) - (currentBodyHeight + footerRowCount)
    // = (6 + 5) - (1 + 2) = 8.
    const lines = makeDialog(
      makeConfig({ getBodyHeight: () => 6, getCurrentBodyHeight: () => 1 }),
    ).render(80);
    const hintIdx = lines.findIndex((l) => l.includes(HINT_PART_ENTER));
    expect(hintIdx).toBeGreaterThan(0);
    const tail = lines.slice(hintIdx + 1);
    expect(tail).toHaveLength(8);
    expect(tail.every((l) => l.trim() === "")).toBe(true);
  });

  it("keeps the height identical across a switch between differently sized tabs", () => {
    const multiQuestion: QuestionData = {
      question: "areas?",
      header: "H2",
      multiSelect: true,
      options: [
        { label: "FE", description: "fe" },
        { label: "BE", description: "be" },
        { label: "DB", description: "db" },
        { label: "QA", description: "qa" },
        { label: "Ops", description: "ops" },
      ],
    };
    const singleQuestion: QuestionData = {
      question: "Q1",
      header: "H1",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    };
    const questions = [singleQuestion, multiQuestion];
    const stateTab0 = makeQuestionnaireState();
    const multiSelect = multiSelectFor(multiQuestion, stateTab0, questions);
    const multiSelectByTab = [undefined, multiSelect];
    const getBodyHeight = (w: number) =>
      Math.max(1, (multiSelect as unknown as { render(w: number): string[] }).render(w).length);

    // The terminal has to be tall enough for both tabs to render without
    // overflow: overflow disables the residual spacer, which is the mechanism
    // being tested here.
    const render = (state: DialogState) =>
      makeDialog(
        makeConfig({
          questions,
          state,
          multiSelectByTab,
          getBodyHeight,
          getTerminalRows: () => 32,
        }),
      ).render(120);

    expect(render(stateTab0)).toHaveLength(
      render(makeQuestionnaireState({ currentTab: 1 })).length,
    );
  });
});
