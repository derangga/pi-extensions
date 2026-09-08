import { describe, expect, it } from "vitest";
import { formatAnswerScalar, NO_INPUT_PLACEHOLDER } from "../src/tool/format-answer.js";
import {
  buildAnswerSegment,
  buildQuestionnaireResponse,
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
  HOST_ERROR_MESSAGE,
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

describe("a host that answers with something it was never offered", () => {
  it("says so instead of reporting a decline", () => {
    const out = buildQuestionnaireResponse(
      {
        answers: [],
        cancelled: true,
        error: "host_error",
        hostErrorDetail: 'selection not in the offered list: "Redis"',
      },
      params("First?"),
    );
    expect(out.content[0]?.text).toContain(HOST_ERROR_MESSAGE);
    expect(out.content[0]?.text).toContain("Redis");
    expect(out.content[0]?.text).not.toContain(DECLINE_MESSAGE);
    expect(out.details.error).toBe("host_error");
    expect(out.details.cancelled).toBe(true);
  });

  it("keeps the answers collected before the host misbehaved", () => {
    const out = buildQuestionnaireResponse(
      {
        answers: [answer({ questionIndex: 0 })],
        cancelled: true,
        error: "host_error",
        hostErrorDetail: 'selection not in the offered list: "???"',
      },
      params("First?", "Second?"),
    );
    expect(out.details.answers).toHaveLength(1);
  });

  it("still reads as a host error with no detail to quote", () => {
    const out = buildQuestionnaireResponse(
      { answers: [], cancelled: true, error: "host_error" },
      params("First?"),
    );
    expect(out.content[0]?.text).toBe(HOST_ERROR_MESSAGE);
    expect(out.details.hostErrorDetail).toBeUndefined();
  });
});

describe("indexing answers and notes by question", () => {
  it("keeps segments in ask order whatever order the answers arrive in", () => {
    const out = buildQuestionnaireResponse(
      {
        answers: [
          answer({ questionIndex: 2, question: "Third?", answer: "C" }),
          answer({ questionIndex: 0, question: "First?", answer: "A" }),
          answer({ questionIndex: 1, question: "Second?", answer: "B" }),
        ],
        cancelled: false,
      },
      params("First?", "Second?", "Third?"),
    );
    const text = out.content[0]?.text ?? "";
    expect(text.indexOf("First?")).toBeLessThan(text.indexOf("Second?"));
    expect(text.indexOf("Second?")).toBeLessThan(text.indexOf("Third?"));
  });

  it("takes the first entry when a question index repeats", () => {
    // What Array.find did. Two answers for one question should not produce two
    // segments, and the earlier one is the one the loop used to reach.
    const out = buildQuestionnaireResponse(
      {
        answers: [
          answer({ questionIndex: 0, question: "First?", answer: "A" }),
          answer({ questionIndex: 0, question: "First?", answer: "B" }),
        ],
        cancelled: false,
      },
      params("First?"),
    );
    const text = out.content[0]?.text ?? "";
    expect(text).toContain('"First?"="A"');
    expect(text).not.toContain('"First?"="B"');
  });

  it("prefers an answer over a note carrying the same index", () => {
    const out = buildQuestionnaireResponse(
      {
        answers: [answer({ questionIndex: 0, question: "First?", answer: "A" })],
        cancelled: false,
        unansweredNotes: [{ questionIndex: 0, question: "First?", note: "n" }],
      },
      params("First?"),
    );
    const text = out.content[0]?.text ?? "";
    expect(text).toContain('"First?"="A"');
    expect(text).not.toContain("note on");
  });
});
