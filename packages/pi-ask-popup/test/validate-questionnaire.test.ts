import { describe, expect, it } from "vitest";
import type { QuestionData, QuestionParams } from "../src/tool/types.js";
import {
  ERROR_DUPLICATE_OPTION_LABEL,
  ERROR_DUPLICATE_QUESTION,
  ERROR_NO_QUESTIONS,
  ERROR_RESERVED_LABEL,
  ERROR_TOO_FEW_OPTIONS,
  ERROR_TOO_MANY_QUESTIONS,
  validateQuestionnaire,
} from "../src/tool/validate-questionnaire.js";

function q(override: Partial<QuestionData> = {}): QuestionData {
  return {
    question: override.question ?? "Which approach?",
    header: override.header ?? "Approach",
    options: override.options ?? [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
    ...(override.multiSelect === undefined ? {} : { multiSelect: override.multiSelect }),
  };
}

function params(...questions: QuestionData[]): QuestionParams {
  return { questions };
}

describe("validateQuestionnaire", () => {
  it("accepts a well-formed questionnaire", () => {
    expect(validateQuestionnaire(params(q()))).toEqual({ ok: true });
  });

  it("accepts the maximum question count", () => {
    const four = [
      q({ question: "1?" }),
      q({ question: "2?" }),
      q({ question: "3?" }),
      q({ question: "4?" }),
    ];
    expect(validateQuestionnaire(params(...four)).ok).toBe(true);
  });

  it("rejects zero questions", () => {
    expect(validateQuestionnaire(params())).toEqual({
      ok: false,
      error: "no_questions",
      message: ERROR_NO_QUESTIONS,
    });
  });

  it("rejects more questions than the cap", () => {
    const five = [1, 2, 3, 4, 5].map((n) => q({ question: `${n}?` }));
    expect(validateQuestionnaire(params(...five))).toEqual({
      ok: false,
      error: "too_many_questions",
      message: ERROR_TOO_MANY_QUESTIONS,
    });
  });

  it("rejects two questions with identical text", () => {
    expect(validateQuestionnaire(params(q(), q()))).toEqual({
      ok: false,
      error: "duplicate_question",
      message: ERROR_DUPLICATE_QUESTION,
    });
  });

  it("rejects a question with fewer options than the minimum", () => {
    expect(
      validateQuestionnaire(params(q({ options: [{ label: "Only", description: "x" }] }))),
    ).toEqual({
      ok: false,
      error: "empty_options",
      message: ERROR_TOO_FEW_OPTIONS,
    });
  });

  it("rejects duplicate option labels within one question", () => {
    const dupes = q({
      options: [
        { label: "Same", description: "a" },
        { label: "Same", description: "b" },
      ],
    });
    expect(validateQuestionnaire(params(dupes))).toEqual({
      ok: false,
      error: "duplicate_option_label",
      message: ERROR_DUPLICATE_OPTION_LABEL,
    });
  });

  it("allows the same option label across different questions", () => {
    // Labels are scoped per question. "Yes" in two questions is normal.
    const a = q({
      question: "First?",
      options: [
        { label: "Yes", description: "y" },
        { label: "No", description: "n" },
      ],
    });
    const b = q({
      question: "Second?",
      options: [
        { label: "Yes", description: "y" },
        { label: "No", description: "n" },
      ],
    });
    expect(validateQuestionnaire(params(a, b)).ok).toBe(true);
  });

  it.each(["Other", "Type something.", "Next"])("rejects the reserved label %s", (label) => {
    const reserved = q({
      options: [
        { label, description: "a" },
        { label: "B", description: "b" },
      ],
    });
    expect(validateQuestionnaire(params(reserved))).toEqual({
      ok: false,
      error: "reserved_label",
      message: ERROR_RESERVED_LABEL,
    });
  });

  it("reports reserved_label when a reserved label is also repeated", () => {
    // Not a precedence test, though it looks like one. A reserved label trips
    // on its first occurrence, when nothing can have been seen yet, so no
    // option is ever both reserved and a duplicate and the two checks cannot
    // disagree. Verified by mutation: swapping them leaves every test green.
    // What this pins is the outcome the model is told to fix, nothing more.
    const both = q({
      options: [
        { label: "Other", description: "a" },
        { label: "Other", description: "b" },
      ],
    });
    expect(validateQuestionnaire(params(both))).toMatchObject({
      ok: false,
      error: "reserved_label",
    });
  });

  it("names every reserved label in the error message, so the model can self-correct", () => {
    expect(ERROR_RESERVED_LABEL).toContain("Other");
    expect(ERROR_RESERVED_LABEL).toContain("Type something.");
    expect(ERROR_RESERVED_LABEL).toContain("Next");
  });

  it("reports the first failing question rather than the last", () => {
    const good = q({ question: "Fine?" });
    const bad = q({ question: "Broken?", options: [{ label: "Only", description: "x" }] });
    expect(validateQuestionnaire(params(bad, good))).toMatchObject({ error: "empty_options" });
  });
});
