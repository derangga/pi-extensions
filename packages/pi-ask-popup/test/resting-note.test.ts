import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { selectTabBarProps } from "../src/state/selectors/projections.js";
import { reduce } from "../src/state/state-reducer.js";
import { buildQuestionnaireResponse } from "../src/tool/response-envelope.js";
import type { QuestionAnswer, QuestionParams } from "../src/tool/types.js";
import { TabBar } from "../src/view/components/tab-bar.js";
import { DialogView, HINT_PART_NOTES, HINT_PART_NOTES_EDIT } from "../src/view/dialog-builder.js";
import { makeConfig, renderJoined, stubComponent } from "./dialog-harness.js";
import {
  makeApplyContext,
  makePerTabContext,
  makeQuestion,
  makeQuestionnaireState,
  makeTheme,
} from "./fixtures.js";

/**
 * A committed note used to vanish the instant its editor closed, and walking
 * back to its tab did not bring it back. These cover the resting row that fixes
 * that, the tab-bar marker beside it, and the note that was being dropped from
 * the result entirely when its question went unanswered.
 */

const TWO_QUESTIONS = [
  makeQuestion({ header: "Pkg", question: "Which package manager?" }),
  makeQuestion({ header: "Node", question: "Which Node version?" }),
];

function answer(index: number, label: string): QuestionAnswer {
  return {
    questionIndex: index,
    question: TWO_QUESTIONS[index]!.question,
    kind: "option",
    answer: label,
  };
}

function stateWith(over: Parameters<typeof makeQuestionnaireState>[0] = {}) {
  return makeQuestionnaireState(over);
}

describe("resting note row", () => {
  it("shows a committed note on its question tab once the editor is closed", () => {
    const out = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab: new Map([[0, "only until the 0.85 upgrade"]]) }),
    });
    expect(out).toContain("notes: only until the 0.85 upgrade");
  });

  it("shows it again after leaving the tab and coming back", () => {
    const notesByTab = new Map([[0, "only until the 0.85 upgrade"]]);
    const away = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 1 }),
    });
    expect(away).not.toContain("only until the 0.85 upgrade");

    const back = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 0 }),
    });
    expect(back).toContain("notes: only until the 0.85 upgrade");
  });

  it("renders no note row when no tab has a note", () => {
    const out = renderJoined({ questions: TWO_QUESTIONS, state: stateWith() });
    expect(out).not.toContain("notes:");
  });

  it("yields the row to the editor while the editor is open", () => {
    const out = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({
        notesByTab: new Map([[0, "only until the 0.85 upgrade"]]),
        notesVisible: true,
      }),
      notesInput: stubComponent(["<NOTES_INPUT>"]) as never,
    });
    expect(out).toContain("<NOTES_INPUT>");
    expect(out).not.toContain("notes: only until the 0.85 upgrade");
  });

  it("collapses a multi-line note onto one row", () => {
    const note = "only until the 0.85 upgrade\nrevisit once engines pins 24\nask the CI owner";
    const rows = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab: new Map([[0, note]]) }),
    })
      .split("\n")
      .filter((r) => r.includes("notes:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("only until the 0.85 upgrade revisit once engines pins 24");
  });

  it("clips a note wider than the pane and marks the cut", () => {
    const rows = renderJoined(
      {
        questions: TWO_QUESTIONS,
        state: stateWith({ notesByTab: new Map([[0, "x".repeat(200)]]) }),
      },
      40,
    )
      .split("\n")
      .filter((r) => r.includes("notes:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("…");
    // Display width, not string length: `theme.fg` wraps the row in escape
    // bytes that cost no columns, so `.length` would overcount by a dozen.
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(40);
  });

  it("reserves the row on an un-noted tab so tab height never changes", () => {
    const notesByTab = new Map([[0, "only until the 0.85 upgrade"]]);
    const noted = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 0 }),
    }).split("\n").length;
    const unnoted = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 1 }),
    }).split("\n").length;
    expect(unnoted).toBe(noted);
  });

  it("keeps the question tab level with the submit tab", () => {
    const notesByTab = new Map([[0, "only until the 0.85 upgrade"]]);
    const question = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 0 }),
    }).split("\n").length;
    const submit = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: TWO_QUESTIONS.length }),
    }).split("\n").length;
    expect(submit).toBe(question);
  });

  it("gives the reserved row back when the last note is cleared", () => {
    const withNote = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab: new Map([[0, "only until the 0.85 upgrade"]]) }),
    }).split("\n").length;
    const without = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith(),
    }).split("\n").length;
    expect(withNote).toBe(without + 1);
  });

  it("reserves with a Spacer, not an empty Text that would render nothing", () => {
    // Text renders zero lines for whitespace-only content, so an empty Text
    // here would reserve nothing and the equalization above would pass while
    // doing nothing at all. Proven by measuring the un-noted tab directly.
    const notesByTab = new Map([[1, "ask the CI owner"]]);
    const reserved = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab, currentTab: 0 }),
    }).split("\n").length;
    const none = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ currentTab: 0 }),
    }).split("\n").length;
    expect(reserved).toBe(none + 1);
  });
});

describe("notes hint", () => {
  it("offers to add a note when the tab has none", () => {
    const out = renderJoined({ questions: TWO_QUESTIONS, state: stateWith() });
    expect(out).toContain(HINT_PART_NOTES);
    expect(out).not.toContain(HINT_PART_NOTES_EDIT);
  });

  it("offers to edit once the tab has one", () => {
    const out = renderJoined({
      questions: TWO_QUESTIONS,
      state: stateWith({ notesByTab: new Map([[0, "only until the 0.85 upgrade"]]) }),
    });
    expect(out).toContain(HINT_PART_NOTES_EDIT);
  });
});

describe("tab bar note marker", () => {
  function barFor(state: ReturnType<typeof makeQuestionnaireState>): string {
    const bar = new TabBar(makeTheme() as unknown as Theme);
    bar.setProps(selectTabBarProps(state, makePerTabContext({ questions: TWO_QUESTIONS, i: 0 })));
    return bar.render(80)[0]!;
  }

  it("marks a noted tab", () => {
    expect(barFor(stateWith({ notesByTab: new Map([[1, "ask the CI owner"]]) }))).toContain(
      "□*Node",
    );
  });

  it("leaves an un-noted tab unmarked", () => {
    expect(barFor(stateWith())).toContain("□ Node");
  });

  it("marks an answered tab that also has a note", () => {
    const state = stateWith({
      answers: new Map([[0, answer(0, "npm")]]),
      notesByTab: new Map([[0, "only until the 0.85 upgrade"]]),
    });
    expect(barFor(state)).toContain("■*Pkg");
  });

  it("costs no width, so the submit tab cannot be truncated away by markers", () => {
    // Four tabs at the schema's header limit already put this bar at 99
    // columns. A suffix marker would make it 103 and push Submit off a
    // 100-column terminal, silently: truncateToWidth is called with an empty
    // ellipsis and drops the tail.
    const wide = [0, 1, 2, 3].map((i) =>
      makeQuestion({ header: "H".repeat(16), question: `Q${i}` }),
    );
    const bar = new TabBar(makeTheme() as unknown as Theme);
    const render = (noted: boolean) => {
      bar.setProps(
        selectTabBarProps(
          stateWith({ notesByTab: noted ? new Map(wide.map((_q, i) => [i, "n"])) : new Map() }),
          makePerTabContext({ questions: wide, i: 0 }),
        ),
      );
      return bar.render(100)[0]!;
    };
    expect(render(true).length).toBe(render(false).length);
    expect(render(true)).toContain("Submit");
  });
});

describe("a note on a question that was never answered", () => {
  const ctx = makeApplyContext({ questions: TWO_QUESTIONS });

  function submit(state: ReturnType<typeof makeQuestionnaireState>) {
    const { effects } = reduce(state, { kind: "submit" }, ctx);
    const done = effects.find((e) => e.kind === "done");
    if (done?.kind !== "done") throw new Error("expected a done effect");
    return done.result;
  }

  it("reaches the result instead of being dropped", () => {
    const result = submit(
      stateWith({
        answers: new Map([[0, answer(0, "npm")]]),
        notesByTab: new Map([[1, "ask the CI owner first"]]),
      }),
    );
    expect(result.unansweredNotes).toEqual([
      { questionIndex: 1, question: "Which Node version?", note: "ask the CI owner first" },
    ]);
  });

  it("is absent from a result with no such notes", () => {
    const result = submit(stateWith({ answers: new Map([[0, answer(0, "npm")]]) }));
    expect("unansweredNotes" in result).toBe(false);
  });

  it("never picks up the global note's pseudo-index", () => {
    const result = submit(
      stateWith({ notesByTab: new Map([[TWO_QUESTIONS.length, "assume Node, not Bun"]]) }),
    );
    expect("unansweredNotes" in result).toBe(false);
    expect(result.globalNote).toBe("assume Node, not Bun");
  });

  it("survives a cancel, like the global note does", () => {
    const { effects } = reduce(
      stateWith({ notesByTab: new Map([[1, "ask the CI owner first"]]) }),
      { kind: "cancel" },
      ctx,
    );
    const done = effects.find((e) => e.kind === "done");
    if (done?.kind !== "done") throw new Error("expected a done effect");
    expect(done.result.unansweredNotes).toHaveLength(1);
  });

  it("appears in the envelope in ask order, between the answers", () => {
    const params: QuestionParams = { questions: TWO_QUESTIONS };
    const { content } = buildQuestionnaireResponse(
      {
        answers: [answer(1, "22")],
        cancelled: false,
        unansweredNotes: [
          { questionIndex: 0, question: "Which package manager?", note: "ask the CI owner first" },
        ],
      },
      params,
    );
    const text = content[0]!.text;
    expect(text).toContain('note on "Which package manager?": ask the CI owner first.');
    expect(text.indexOf("note on")).toBeLessThan(text.indexOf('"Which Node version?"'));
  });

  it("counts as an answer rather than a decline when it is all there is", () => {
    const params: QuestionParams = { questions: TWO_QUESTIONS };
    const { content, details } = buildQuestionnaireResponse(
      {
        answers: [],
        cancelled: false,
        unansweredNotes: [
          { questionIndex: 0, question: "Which package manager?", note: "ask the CI owner first" },
        ],
      },
      params,
    );
    expect(content[0]!.text).toContain("ask the CI owner first");
    expect(details.cancelled).toBe(false);
  });

  it("rides a cancelled envelope's details", () => {
    const params: QuestionParams = { questions: TWO_QUESTIONS };
    const { details } = buildQuestionnaireResponse(
      {
        answers: [],
        cancelled: true,
        unansweredNotes: [
          { questionIndex: 0, question: "Which package manager?", note: "ask the CI owner first" },
        ],
      },
      params,
    );
    expect(details.unansweredNotes).toHaveLength(1);
  });

  it("rides a timed-out envelope's details", () => {
    const params: QuestionParams = { questions: TWO_QUESTIONS };
    const { details } = buildQuestionnaireResponse(
      {
        answers: [],
        cancelled: true,
        error: "timed_out",
        unansweredNotes: [
          { questionIndex: 0, question: "Which package manager?", note: "ask the CI owner first" },
        ],
      },
      params,
    );
    expect(details.unansweredNotes).toHaveLength(1);
  });
});

describe("submit review", () => {
  function review(state: ReturnType<typeof makeQuestionnaireState>): string {
    const parts = makeConfig({
      questions: TWO_QUESTIONS,
      state: { ...state, currentTab: TWO_QUESTIONS.length },
    });
    return new DialogView(parts.config, parts.initialProps).render(80).join("\n");
  }

  it("lists a note-only question with no arrow row", () => {
    const out = review(stateWith({ notesByTab: new Map([[1, "ask the CI owner first"]]) }));
    const lines = out.split("\n");
    const bullet = lines.findIndex((l) => l.includes("● Node"));
    expect(bullet).toBeGreaterThanOrEqual(0);
    expect(lines[bullet + 1]).toContain("notes: ask the CI owner first");
    expect(lines[bullet + 1]).not.toContain("→");
  });

  it("keeps the arrow row for an answered question that also has a note", () => {
    const out = review(
      stateWith({
        answers: new Map([[0, answer(0, "npm")]]),
        notesByTab: new Map([[0, "only until the 0.85 upgrade"]]),
      }),
    );
    const lines = out.split("\n");
    const bullet = lines.findIndex((l) => l.includes("● Pkg"));
    expect(lines[bullet + 1]).toContain("→");
    expect(lines[bullet + 1]).toContain("npm");
    expect(lines[bullet + 2]).toContain("notes: only until the 0.85 upgrade");
  });

  it("still names a note-only question as unanswered", () => {
    const out = review(stateWith({ notesByTab: new Map([[1, "ask the CI owner first"]]) }));
    expect(out).toContain("Node");
    expect(out).toContain("Answer remaining questions before submitting:");
  });
});
