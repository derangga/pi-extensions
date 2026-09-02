import { describe, expect, it, vi } from "vitest";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "../src/rpc-fallback.js";
import { ROW_INTENT_META } from "../src/state/row-intent.js";
import type { QuestionData, QuestionParams } from "../src/tool/types.js";
import { makeQuestion } from "./fixtures.js";

/**
 * The walker, on its own. Host routing -- which path a given `ctx.mode` takes,
 * and the backstop for a host whose `custom()` resolves undefined -- lives with
 * the tool wiring, because that is where the decision is made.
 */

interface Recorder extends DialogUI {
  selectCalls: { title: string; options: string[] }[];
  inputCalls: { title: string; placeholder?: string }[];
}

/**
 * A host that answers each dialog from a queue. Anything the queue does not
 * cover resolves undefined, which is a dismissal -- so a test that forgets an
 * answer sees a cancel rather than a hang.
 */
function makeUI(replies: (string | undefined)[]): Recorder {
  const queue = [...replies];
  const selectCalls: Recorder["selectCalls"] = [];
  const inputCalls: Recorder["inputCalls"] = [];
  return {
    selectCalls,
    inputCalls,
    select: (title, options) => {
      selectCalls.push({ title, options });
      return Promise.resolve(queue.shift());
    },
    input: (title, placeholder) => {
      inputCalls.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
      return Promise.resolve(queue.shift());
    },
  };
}

function params(...questions: QuestionData[]): QuestionParams {
  return { questions };
}

const PICK_ONE = makeQuestion({
  question: "Which cache?",
  header: "Cache",
  options: [
    { label: "Redis", description: "shared" },
    { label: "In-process", description: "simple" },
  ],
});

const PICK_MANY = makeQuestion({ ...PICK_ONE, multiSelect: true });

describe("hasDialogUI", () => {
  it("accepts a host carrying both primitives", () => {
    expect(hasDialogUI({ select: () => {}, input: () => {} })).toBe(true);
  });

  it("rejects a host missing either one", () => {
    // Both are needed: the single-select path falls through to `input` for the
    // custom-answer row, so a host with only `select` would break mid-question.
    expect(hasDialogUI({ select: () => {} })).toBe(false);
    expect(hasDialogUI({ input: () => {} })).toBe(false);
  });

  it("rejects non-objects and non-function properties", () => {
    // jiti transpiles without type-checking, so this guard is the only thing
    // standing between a malformed host and a call on undefined.
    expect(hasDialogUI(undefined)).toBe(false);
    expect(hasDialogUI(null)).toBe(false);
    expect(hasDialogUI("ui")).toBe(false);
    expect(hasDialogUI({ select: "yes", input: "yes" })).toBe(false);
  });
});

describe("single-select", () => {
  it("returns the chosen option's label", async () => {
    const ui = makeUI(["1. Redis — shared"]);
    const result = await runRpcQuestionnaire(ui, params(PICK_ONE));
    expect(result.cancelled).toBe(false);
    expect(result.answers).toEqual([
      { questionIndex: 0, question: "Which cache?", kind: "option", answer: "Redis" },
    ]);
  });

  it("numbers the options and puts the header in the title", async () => {
    const ui = makeUI(["1. Redis — shared"]);
    await runRpcQuestionnaire(ui, params(PICK_ONE));
    expect(ui.selectCalls[0]?.title).toBe("[Cache] Which cache?");
    expect(ui.selectCalls[0]?.options.slice(0, 2)).toEqual([
      "1. Redis — shared",
      "2. In-process — simple",
    ]);
  });

  it("appends the custom-answer row from the same metadata the overlay uses", async () => {
    // Not a literal: the overlay row and this one have to say the same thing,
    // and there is exactly one place that decides what that is.
    const ui = makeUI(["1. Redis — shared"]);
    await runRpcQuestionnaire(ui, params(PICK_ONE));
    expect(ui.selectCalls[0]?.options.at(-1)).toBe(`3. ${ROW_INTENT_META.other.label}`);
  });

  it("follows the custom-answer row with a free-text prompt", async () => {
    const ui = makeUI([`3. ${ROW_INTENT_META.other.label}`, "Memcached, actually"]);
    const result = await runRpcQuestionnaire(ui, params(PICK_ONE));
    expect(result.answers).toEqual([
      {
        questionIndex: 0,
        question: "Which cache?",
        kind: "custom",
        answer: "Memcached, actually",
      },
    ]);
    expect(ui.inputCalls[0]?.title).toContain("Type your answer:");
  });

  it("keeps an empty typed answer rather than discarding it", async () => {
    // Empty is not the same as dismissed: the user committed the dialog.
    const ui = makeUI([`3. ${ROW_INTENT_META.other.label}`, ""]);
    const result = await runRpcQuestionnaire(ui, params(PICK_ONE));
    expect(result.cancelled).toBe(false);
    expect(result.answers[0]).toMatchObject({ kind: "custom", answer: "" });
  });
});

describe("previews", () => {
  const withPreview = makeQuestion({
    question: "Which layout?",
    header: "Layout",
    options: [
      { label: "Grid", description: "columns", preview: "# Grid\nrows and columns" },
      { label: "List", description: "stacked" },
    ],
  });

  it("folds them into the select title, since there is no pane", async () => {
    const ui = makeUI(["1. Grid — columns"]);
    await runRpcQuestionnaire(ui, params(withPreview));
    const title = ui.selectCalls[0]?.title ?? "";
    expect(title).toContain("--- 1. Grid preview ---");
    expect(title).toContain("rows and columns");
  });

  it("mentions only the options that carry one", async () => {
    const ui = makeUI(["1. Grid — columns"]);
    await runRpcQuestionnaire(ui, params(withPreview));
    expect(ui.selectCalls[0]?.title).not.toContain("2. List preview");
  });

  it("truncates a long preview at 600 characters", async () => {
    // A dialog title is not a document viewer, and some hosts render it in a
    // fixed-height box that simply loses whatever runs past the bottom.
    const long = "x".repeat(2000);
    const ui = makeUI(["1. Big — b"]);
    await runRpcQuestionnaire(
      ui,
      params(
        makeQuestion({
          options: [
            { label: "Big", description: "b", preview: long },
            { label: "Small", description: "s" },
          ],
        }),
      ),
    );
    const title = ui.selectCalls[0]?.title ?? "";
    expect(title).toContain("x".repeat(600));
    expect(title).not.toContain("x".repeat(601));
  });

  it("echoes the chosen option's preview back in the answer", async () => {
    const ui = makeUI(["1. Grid — columns"]);
    const result = await runRpcQuestionnaire(ui, params(withPreview));
    expect(result.answers[0]).toMatchObject({
      answer: "Grid",
      preview: "# Grid\nrows and columns",
    });
  });

  it("omits the preview key entirely when the chosen option has none", async () => {
    // The envelope's contract: absent, not present-and-undefined.
    const ui = makeUI(["2. List — stacked"]);
    const result = await runRpcQuestionnaire(ui, params(withPreview));
    expect(result.answers[0] && "preview" in result.answers[0]).toBe(false);
  });

  it("treats an empty preview string as no preview", async () => {
    const ui = makeUI(["1. Grid — columns"]);
    const result = await runRpcQuestionnaire(
      ui,
      params(
        makeQuestion({
          options: [
            { label: "Grid", description: "columns", preview: "" },
            { label: "List", description: "stacked" },
          ],
        }),
      ),
    );
    expect(ui.selectCalls[0]?.title).not.toContain("preview ---");
    expect(result.answers[0] && "preview" in result.answers[0]).toBe(false);
  });
});

describe("multi-select", () => {
  it("asks for numbers and turns them into labels", async () => {
    const ui = makeUI(["1,2"]);
    const result = await runRpcQuestionnaire(ui, params(PICK_MANY));
    expect(result.answers).toEqual([
      {
        questionIndex: 0,
        question: "Which cache?",
        kind: "multi",
        answer: null,
        selected: ["Redis", "In-process"],
      },
    ]);
    expect(ui.selectCalls).toHaveLength(0);
    expect(ui.inputCalls[0]?.placeholder).toBe("1,3");
  });

  it("lists the numbered options and how to answer in the prompt", async () => {
    const ui = makeUI(["1"]);
    await runRpcQuestionnaire(ui, params(PICK_MANY));
    const title = ui.inputCalls[0]?.title ?? "";
    expect(title).toContain("1. Redis — shared");
    expect(title).toContain("2. In-process — simple");
    expect(title).toContain("comma-separated");
  });

  it.each([
    ["commas", "1,2"],
    ["spaces", "1 2"],
    ["both", "1, 2"],
    ["trailing dots, as a list reads", "1. 2."],
  ])("accepts indices separated by %s", async (_label, input) => {
    const result = await runRpcQuestionnaire(makeUI([input]), params(PICK_MANY));
    expect(result.answers[0]).toMatchObject({ kind: "multi", selected: ["Redis", "In-process"] });
  });

  it("keeps the order the user typed and drops repeats", async () => {
    const result = await runRpcQuestionnaire(makeUI(["2,1,2"]), params(PICK_MANY));
    expect(result.answers[0]).toMatchObject({ selected: ["In-process", "Redis"] });
  });

  it("commits an empty selection for empty input", async () => {
    // Pressing Next with nothing ticked, which is a real answer: none of these.
    for (const blank of ["", "   "]) {
      const result = await runRpcQuestionnaire(makeUI([blank]), params(PICK_MANY));
      expect(result.cancelled).toBe(false);
      expect(result.answers[0]).toMatchObject({ kind: "multi", selected: [] });
    }
  });

  it("treats words as a typed answer rather than dropping them", async () => {
    // This is the multi-select half of the "Type something." escape. Silently
    // discarding what someone typed is the worst option available.
    const result = await runRpcQuestionnaire(makeUI(["neither, use SQLite"]), params(PICK_MANY));
    expect(result.answers[0]).toEqual({
      questionIndex: 0,
      question: "Which cache?",
      kind: "custom",
      answer: "neither, use SQLite",
    });
  });

  it("treats an out-of-range number as typed text, not a selection", async () => {
    // "13" against three options is far more likely to be an answer than a
    // mis-typed index, and guessing which index they meant would be worse.
    const result = await runRpcQuestionnaire(makeUI(["13"]), params(PICK_MANY));
    expect(result.answers[0]).toMatchObject({ kind: "custom", answer: "13" });
  });

  it("treats a partly-valid list as typed text rather than keeping half of it", async () => {
    const result = await runRpcQuestionnaire(makeUI(["1, banana"]), params(PICK_MANY));
    expect(result.answers[0]).toMatchObject({ kind: "custom", answer: "1, banana" });
  });

  it("rejects zero, which is nobody's first option", async () => {
    const result = await runRpcQuestionnaire(makeUI(["0"]), params(PICK_MANY));
    expect(result.answers[0]).toMatchObject({ kind: "custom", answer: "0" });
  });
});

describe("dismissal", () => {
  it("cancels the questionnaire when a select is dismissed", async () => {
    const result = await runRpcQuestionnaire(makeUI([undefined]), params(PICK_ONE));
    expect(result).toEqual({ answers: [], cancelled: true });
  });

  it("cancels when the follow-up text prompt is dismissed", async () => {
    const ui = makeUI([`3. ${ROW_INTENT_META.other.label}`, undefined]);
    expect(await runRpcQuestionnaire(ui, params(PICK_ONE))).toEqual({
      answers: [],
      cancelled: true,
    });
  });

  it("cancels when a multi-select prompt is dismissed", async () => {
    const result = await runRpcQuestionnaire(makeUI([undefined]), params(PICK_MANY));
    expect(result).toEqual({ answers: [], cancelled: true });
  });

  it("keeps the answers already given when a later question is dismissed", async () => {
    // The envelope reports a decline either way, but throwing away work the
    // user already did would be gratuitous.
    const ui = makeUI(["1. Redis — shared", undefined]);
    const result = await runRpcQuestionnaire(ui, params(PICK_ONE, PICK_MANY));
    expect(result.cancelled).toBe(true);
    expect(result.answers).toHaveLength(1);
  });

  it("cancels rather than inventing an answer when the host returns something off-list", async () => {
    // A host that hands back a string it was never offered is indistinguishable
    // from one that was dismissed, and fabricating a choice would put words in
    // the user's mouth.
    const result = await runRpcQuestionnaire(makeUI(["Redis"]), params(PICK_ONE));
    expect(result).toEqual({ answers: [], cancelled: true });
  });
});

describe("walking several questions", () => {
  it("asks them in order, one dialog each", async () => {
    const first = makeQuestion({ question: "First?", header: "One" });
    const second = makeQuestion({ question: "Second?", header: "Two" });
    const ui = makeUI(["1. A — a", "2. B — b"]);
    const result = await runRpcQuestionnaire(ui, params(first, second));
    expect(ui.selectCalls.map((c) => c.title)).toEqual(["[One] First?", "[Two] Second?"]);
    expect(result.answers.map((a) => a.answer)).toEqual(["A", "B"]);
    expect(result.answers.map((a) => a.questionIndex)).toEqual([0, 1]);
  });

  it("mixes single and multi-select in one walk", async () => {
    const ui = makeUI(["1. A — a", "1,2"]);
    const result = await runRpcQuestionnaire(
      ui,
      params(makeQuestion(), makeQuestion({ multiSelect: true })),
    );
    expect(ui.selectCalls).toHaveLength(1);
    expect(ui.inputCalls).toHaveLength(1);
    expect(result.answers.map((a) => a.kind)).toEqual(["option", "multi"]);
  });

  it("waits for each dialog before opening the next", async () => {
    // Sequential, not concurrent: a host asked to render four dialogs at once
    // would stack them, and the user would answer them out of order.
    const open: number[] = [];
    let settle: (() => void) | undefined;
    const ui: DialogUI = {
      select: (title) => {
        open.push(open.length);
        return new Promise((resolve) => {
          settle = () => resolve(title.includes("First") ? "1. A — a" : "2. B — b");
        });
      },
      input: () => Promise.resolve(undefined),
    };
    const walk = runRpcQuestionnaire(
      ui,
      params(makeQuestion({ question: "First?" }), makeQuestion({ question: "Second?" })),
    );
    await vi.waitFor(() => expect(settle).toBeDefined());
    expect(open).toHaveLength(1);
    settle?.();
    await vi.waitFor(() => expect(open).toHaveLength(2));
    settle?.();
    await walk;
  });

  it("carries no notes on this path", async () => {
    // Neither primitive has a field for one, and a second dialog per question
    // to collect something most answers never use is a bad trade. Documented,
    // not faked.
    const ui = makeUI(["1. A — a"]);
    const result = await runRpcQuestionnaire(ui, params(makeQuestion()));
    expect(result.answers[0] && "notes" in result.answers[0]).toBe(false);
    expect("globalNote" in result).toBe(false);
  });
});
