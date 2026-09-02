import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  isQuestionnaireResult,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  QuestionParamsSchema,
  QuestionsSchema,
  RESERVED_LABELS,
} from "../src/tool/types.js";

function makeQuestion(override: Partial<QuestionData> = {}): QuestionData {
  return {
    question: override.question ?? "What's your name?",
    header: override.header ?? "Hdr",
    options: override.options ?? [
      { label: "A", description: "Choice A" },
      { label: "B", description: "Choice B" },
    ],
    // Conditional spread, not `multiSelect: override.multiSelect`.
    // exactOptionalPropertyTypes rejects an explicit undefined on an optional
    // property, and the schema treats absent and false differently anyway.
    ...(override.multiSelect === undefined ? {} : { multiSelect: override.multiSelect }),
  };
}

describe("QuestionsSchema — array constraints", () => {
  it("accepts a single question", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion()])).toBe(true);
  });

  it("accepts MAX_QUESTIONS questions", () => {
    const four = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
    expect(Value.Check(QuestionsSchema, four)).toBe(true);
  });

  it("rejects an empty array", () => {
    expect(Value.Check(QuestionsSchema, [])).toBe(false);
  });

  it("rejects more than MAX_QUESTIONS", () => {
    const five = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
    expect(Value.Check(QuestionsSchema, five)).toBe(false);
    expect(MAX_QUESTIONS).toBe(4);
  });
});

describe("QuestionSchema — option, preview, multiSelect, header shape", () => {
  it("accepts options carrying a preview", () => {
    const q = makeQuestion({
      options: [
        { label: "A", description: "alpha", preview: "## A\n\nbody" },
        { label: "B", description: "beta" },
      ],
    });
    expect(Value.Check(QuestionsSchema, [q])).toBe(true);
  });

  it("accepts a question with every optional field populated", () => {
    const q: QuestionData = {
      question: "Pick architecture",
      header: "Architecture",
      options: [
        {
          label: "Monolith",
          description: "Single deployable unit",
          preview: "## Monolith\n\nSimple",
        },
        {
          label: "Microservices",
          description: "Distributed services",
          preview: "## Micro\n\nScalable",
        },
      ],
      multiSelect: false,
    };
    expect(Value.Check(QuestionsSchema, [q])).toBe(true);
  });

  it("accepts multiSelect: true", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion({ multiSelect: true })])).toBe(true);
  });

  it("accepts a header of exactly MAX_HEADER_LENGTH characters", () => {
    expect(
      Value.Check(QuestionsSchema, [makeQuestion({ header: "x".repeat(MAX_HEADER_LENGTH) })]),
    ).toBe(true);
  });

  it("rejects a single-option question", () => {
    expect(
      Value.Check(QuestionsSchema, [
        makeQuestion({ options: [{ label: "OK", description: "Only choice" }] }),
      ]),
    ).toBe(false);
  });

  it("rejects an empty options array", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion({ options: [] })])).toBe(false);
  });

  it("rejects more than MAX_OPTIONS options", () => {
    const five = [
      { label: "A", description: "alpha" },
      { label: "B", description: "beta" },
      { label: "C", description: "gamma" },
      { label: "D", description: "delta" },
      { label: "E", description: "epsilon" },
    ];
    expect(Value.Check(QuestionsSchema, [makeQuestion({ options: five })])).toBe(false);
    expect(MAX_OPTIONS).toBe(4);
  });

  it("rejects an option missing its description", () => {
    const broken = makeQuestion({
      options: [{ label: "A" } as never, { label: "B", description: "ok" }],
    });
    expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
  });

  it("rejects a question missing its header", () => {
    const noHeader = {
      question: "Q?",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    };
    expect(Value.Check(QuestionsSchema, [noHeader])).toBe(false);
  });

  it("rejects a header over MAX_HEADER_LENGTH", () => {
    expect(
      Value.Check(QuestionsSchema, [makeQuestion({ header: "x".repeat(MAX_HEADER_LENGTH + 1) })]),
    ).toBe(false);
  });

  it("rejects a label over MAX_LABEL_LENGTH", () => {
    const tooLong = "x".repeat(MAX_LABEL_LENGTH + 1);
    expect(
      Value.Check(QuestionsSchema, [
        makeQuestion({
          options: [
            { label: tooLong, description: "a" },
            { label: "B", description: "b" },
          ],
        }),
      ]),
    ).toBe(false);
  });

  it("rejects a question missing its question text", () => {
    const broken = {
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    } as unknown;
    expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
  });
});

describe("QuestionParamsSchema — top-level shape", () => {
  it("accepts { questions: [...] }", () => {
    expect(Value.Check(QuestionParamsSchema, { questions: [makeQuestion()] })).toBe(true);
  });

  it("accepts a full payload with preview and multiSelect", () => {
    const payload = {
      questions: [
        {
          question: "Choose",
          header: "Pick",
          multiSelect: true,
          options: [
            { label: "A", description: "First", preview: "# A" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    };
    expect(Value.Check(QuestionParamsSchema, payload)).toBe(true);
  });

  it("rejects a missing questions field", () => {
    expect(Value.Check(QuestionParamsSchema, {})).toBe(false);
  });

  it("rejects a non-array questions field", () => {
    expect(Value.Check(QuestionParamsSchema, { questions: "not array" })).toBe(false);
  });
});

describe("QuestionAnswer — optional fields", () => {
  it("carries notes", () => {
    const a: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      kind: "option",
      answer: "A",
      notes: "preview looked good",
    };
    expect(a.notes).toBe("preview looked good");
  });

  it("carries selected labels with a null scalar for multi-select", () => {
    const a: QuestionAnswer = {
      questionIndex: 1,
      question: "Areas?",
      kind: "multi",
      answer: null,
      selected: ["Frontend", "Backend"],
    };
    expect(a.selected).toEqual(["Frontend", "Backend"]);
    expect(a.answer).toBeNull();
  });

  it("carries the preview of the option the user chose", () => {
    const a: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      kind: "option",
      answer: "A",
      preview: "## Heading\n\nbody",
    };
    expect(a.preview).toContain("## Heading");
  });
});

describe("QuestionAnswer.kind — the only discriminator", () => {
  it("supports all three variants", () => {
    const optionA: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      kind: "option",
      answer: "A",
    };
    const customA: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      kind: "custom",
      answer: "free text",
    };
    const multiA: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      kind: "multi",
      answer: null,
      selected: ["A", "B"],
    };
    expect(optionA.kind).toBe("option");
    expect(customA.kind).toBe("custom");
    expect(multiA.kind).toBe("multi");
  });
});

describe("isQuestionnaireResult", () => {
  it("accepts a valid result", () => {
    const r: QuestionnaireResult = { answers: [], cancelled: false };
    expect(isQuestionnaireResult(r)).toBe(true);
  });

  it("accepts a result carrying an error", () => {
    expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "no_ui" })).toBe(true);
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_question" }),
    ).toBe(true);
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_option_label" }),
    ).toBe(true);
    expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "reserved_label" })).toBe(
      true,
    );
  });

  it("accepts a result carrying a global note, submitted or cancelled", () => {
    expect(
      isQuestionnaireResult({ answers: [], cancelled: false, globalNote: "ship it Friday" }),
    ).toBe(true);
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, globalNote: "kept on cancel" }),
    ).toBe(true);
  });

  it("accepts a result with populated answers", () => {
    expect(
      isQuestionnaireResult({
        answers: [{ questionIndex: 0, question: "Q?", answer: "A" }],
        cancelled: false,
      }),
    ).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isQuestionnaireResult(null)).toBe(false);
    expect(isQuestionnaireResult(undefined)).toBe(false);
  });

  it("rejects primitives and arrays", () => {
    expect(isQuestionnaireResult(42)).toBe(false);
    expect(isQuestionnaireResult("oops")).toBe(false);
    expect(isQuestionnaireResult([])).toBe(false);
  });

  it("rejects objects missing a required field", () => {
    expect(isQuestionnaireResult({ answers: [] })).toBe(false);
    expect(isQuestionnaireResult({ cancelled: true })).toBe(false);
  });
});

describe("schema constants and reserved labels", () => {
  it("exports the documented limits", () => {
    expect(MIN_OPTIONS).toBe(2);
    expect(MAX_OPTIONS).toBe(4);
    expect(MAX_HEADER_LENGTH).toBe(16);
    expect(MAX_LABEL_LENGTH).toBe(60);
  });

  it("reserves the two runtime sentinels plus Claude Code's 'Other'", () => {
    expect(RESERVED_LABELS).toEqual(["Other", "Type something.", "Next"]);
  });
});
