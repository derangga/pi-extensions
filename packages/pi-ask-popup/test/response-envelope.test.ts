import { describe, expect, it } from "vitest";
import { formatAnswerScalar, NO_INPUT_PLACEHOLDER } from "../src/tool/format-answer.js";
import {
  buildAnswerSegment,
  buildQuestionnaireResponse,
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
} from "../src/tool/response-envelope.js";
import type { QuestionAnswer, QuestionParams } from "../src/tool/types.js";

function params(...questions: string[]): QuestionParams {
  return {
    questions: questions.map((question) => ({
      question,
      header: "H",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    })),
  };
}

function answer(override: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    questionIndex: override.questionIndex ?? 0,
    question: override.question ?? "First?",
    kind: override.kind ?? "option",
    answer: override.answer === undefined ? "A" : override.answer,
    ...(override.selected === undefined ? {} : { selected: override.selected }),
    ...(override.notes === undefined ? {} : { notes: override.notes }),
    ...(override.preview === undefined ? {} : { preview: override.preview }),
  };
}

describe("formatAnswerScalar", () => {
  it("joins multi-select labels", () => {
    expect(
      formatAnswerScalar(answer({ kind: "multi", answer: null, selected: ["A", "B"] }), "envelope"),
    ).toBe("A, B");
  });

  it("falls back to the placeholder for every empty variant", () => {
    expect(
      formatAnswerScalar(answer({ kind: "multi", answer: null, selected: [] }), "envelope"),
    ).toBe(NO_INPUT_PLACEHOLDER);
    expect(formatAnswerScalar(answer({ kind: "custom", answer: "" }), "envelope")).toBe(
      NO_INPUT_PLACEHOLDER,
    );
    expect(formatAnswerScalar(answer({ kind: "option", answer: null }), "envelope")).toBe(
      NO_INPUT_PLACEHOLDER,
    );
  });

  it("returns typed text verbatim, newlines included", () => {
    expect(
      formatAnswerScalar(answer({ kind: "custom", answer: "line one\nline two" }), "envelope"),
    ).toBe("line one\nline two");
  });
});

describe("buildAnswerSegment", () => {
  it("renders question and answer as a quoted pair", () => {
    expect(buildAnswerSegment(answer())).toBe('"First?"="A".');
  });

  it("appends the preview the user was looking at", () => {
    expect(buildAnswerSegment(answer({ preview: "# Mock" }))).toBe(
      '"First?"="A". selected preview: # Mock.',
    );
  });

  it("appends notes", () => {
    expect(buildAnswerSegment(answer({ notes: "check perf" }))).toBe(
      '"First?"="A". user notes: check perf.',
    );
  });

  it("omits empty preview and notes rather than emitting bare labels", () => {
    expect(buildAnswerSegment(answer({ preview: "", notes: "" }))).toBe('"First?"="A".');
  });
});

describe("buildQuestionnaireResponse", () => {
  it("declines on a null result", () => {
    const r = buildQuestionnaireResponse(null, params("First?"));
    expect(r.content[0]?.text).toBe(DECLINE_MESSAGE);
    expect(r.details.cancelled).toBe(true);
  });

  it("declines on a cancelled result but keeps partial answers in details", () => {
    const partial = [answer()];
    const r = buildQuestionnaireResponse({ answers: partial, cancelled: true }, params("First?"));
    expect(r.content[0]?.text).toBe(DECLINE_MESSAGE);
    expect(r.details.answers).toEqual(partial);
  });

  it("keeps a global note on a cancelled result", () => {
    const r = buildQuestionnaireResponse(
      { answers: [], cancelled: true, globalNote: "ask me later" },
      params("First?"),
    );
    expect(r.content[0]?.text).toBe(DECLINE_MESSAGE);
    expect(r.details.globalNote).toBe("ask me later");
  });

  it("wraps answered segments in the prefix and suffix", () => {
    const r = buildQuestionnaireResponse(
      { answers: [answer()], cancelled: false },
      params("First?"),
    );
    expect(r.content[0]?.text).toBe(`${ENVELOPE_PREFIX} "First?"="A". ${ENVELOPE_SUFFIX}`);
  });

  it("orders segments by the question order, not the answer order", () => {
    // The user can fill tabs in any order. The model asked in a fixed one.
    const out = buildQuestionnaireResponse(
      {
        answers: [
          answer({ questionIndex: 1, question: "Second?", answer: "B" }),
          answer({ questionIndex: 0, question: "First?", answer: "A" }),
        ],
        cancelled: false,
      },
      params("First?", "Second?"),
    );
    expect(out.content[0]?.text.indexOf("First?")).toBeLessThan(
      out.content[0]?.text.indexOf("Second?") ?? -1,
    );
  });

  it("omits unanswered questions instead of padding them", () => {
    const r = buildQuestionnaireResponse(
      { answers: [answer()], cancelled: false },
      params("First?", "Second?"),
    );
    expect(r.content[0]?.text).not.toContain("Second?");
  });

  it("treats a global note with no answers as answered, not declined", () => {
    // The note segment is appended before the emptiness check on purpose:
    // someone who wrote a note and submitted has told the model something.
    const r = buildQuestionnaireResponse(
      { answers: [], cancelled: false, globalNote: "ship Friday" },
      params("First?"),
    );
    expect(r.content[0]?.text).toContain("global note: ship Friday.");
    expect(r.content[0]?.text).not.toBe(DECLINE_MESSAGE);
  });

  it("declines when a submitted result carries nothing at all", () => {
    const r = buildQuestionnaireResponse({ answers: [], cancelled: false }, params("First?"));
    expect(r.content[0]?.text).toBe(DECLINE_MESSAGE);
    expect(r.details.cancelled).toBe(true);
  });

  it("places the global note after the per-question segments", () => {
    const r = buildQuestionnaireResponse(
      { answers: [answer()], cancelled: false, globalNote: "and one more thing" },
      params("First?"),
    );
    const text = r.content[0]?.text ?? "";
    expect(text.indexOf('"First?"')).toBeLessThan(text.indexOf("global note:"));
  });

  it("never emits a globalNote key for a note-free result", () => {
    // The conditional-spread contract: absent, not undefined, so a note-free
    // result stays byte-identical for anything comparing or replaying it.
    const r = buildQuestionnaireResponse(
      { answers: [answer()], cancelled: false },
      params("First?"),
    );
    expect("globalNote" in r.details).toBe(false);
  });
});
