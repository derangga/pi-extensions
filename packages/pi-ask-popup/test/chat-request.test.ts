import { describe, expect, it } from "vitest";
import { routeKey } from "../src/state/key-router.js";
import { ROW_INTENT_META, type WrappingSelectItem } from "../src/state/row-intent.js";
import { type Effect, reduce } from "../src/state/state-reducer.js";
import {
  buildQuestionnaireResponse,
  CHAT_REQUEST_INSTRUCTION,
} from "../src/tool/response-envelope.js";
import type { QuestionData, QuestionParams, QuestionnaireResult } from "../src/tool/types.js";
import { runRpcQuestionnaire, type DialogUI } from "../src/rpc-fallback.js";
import type { QuestionnaireRuntime } from "../src/state/state.js";
import {
  makeApplyContext as makeCtx,
  makeQuestion,
  makeQuestionnaireState as makeState,
} from "./fixtures.js";

/**
 * The "Chat About This" sentinel, end to end through its layers: the router
 * that turns Enter into the request, the reducer that closes the dialog with
 * the marker attached, the envelope that tells the model what happened, and
 * the RPC walker that mirrors the row for hosts without the overlay.
 */

const KEY = {
  CONFIRM: "<KEY:tui.select.confirm>",
  CANCEL: "<KEY:tui.select.cancel>",
  UP: "<KEY:tui.select.up>",
  DOWN: "<KEY:tui.select.down>",
};
// Same trick key-router.test.ts uses: key names are encoded in the data byte so
// the stub can distinguish confirm from cancel without a real TUI.
const keybindings = {
  matches: (data: string, name: string) => data === `<KEY:${name}>`,
};

function itemsFor(question: QuestionData): WrappingSelectItem[] {
  const out: WrappingSelectItem[] = question.options.map((o) => ({
    kind: "option" as const,
    label: o.label,
  }));
  out.push({ kind: "other", label: ROW_INTENT_META.other.label });
  out.push({ kind: "chat", label: ROW_INTENT_META.chat.label });
  if (question.multiSelect) {
    out.push({ kind: "next", label: ROW_INTENT_META.next.label });
  }
  return out;
}

function makeRuntime(
  questions: readonly QuestionData[],
  over: Partial<QuestionnaireRuntime> = {},
): QuestionnaireRuntime {
  return {
    keybindings,
    inputBuffer: "",
    canMoveInputUp: false,
    canMoveInputDown: false,
    questions,
    isMulti: questions.length > 1,
    currentItem: undefined,
    items: itemsFor(questions[0]!),
    collapseKey: "off",
    ...over,
  };
}

function answer(
  i: number,
  q: string,
  label: string,
): {
  questionIndex: number;
  question: string;
  kind: "option";
  answer: string;
} {
  return { questionIndex: i, question: q, kind: "option", answer: label };
}

describe("routeKey — the chat row", () => {
  const single = [makeQuestion()];
  const chatIndex = itemsFor(single[0]!).findIndex((i) => i.kind === "chat");

  it("Enter on the chat row emits chat_request on a single-select tab", () => {
    const a = routeKey(
      KEY.CONFIRM,
      makeState({ optionIndex: chatIndex }),
      makeRuntime(single, {
        currentItem: itemsFor(single[0]!)[chatIndex],
        items: itemsFor(single[0]!),
      }),
    );
    expect(a).toEqual({ kind: "chat_request" });
  });

  it("Enter on the chat row emits chat_request on a multi-select tab", () => {
    const multi = [makeQuestion({ multiSelect: true })];
    const items = itemsFor(multi[0]!);
    const index = items.findIndex((i) => i.kind === "chat");
    const a = routeKey(
      KEY.CONFIRM,
      makeState({ optionIndex: index }),
      makeRuntime(multi, { currentItem: items[index], items }),
    );
    expect(a).toEqual({ kind: "chat_request" });
  });

  it("Space on the chat row does nothing, like the commit row", () => {
    const multi = [makeQuestion({ multiSelect: true })];
    const items = itemsFor(multi[0]!);
    const index = items.findIndex((i) => i.kind === "chat");
    const a = routeKey(
      " ",
      makeState({ optionIndex: index }),
      makeRuntime(multi, { currentItem: items[index], items }),
    );
    expect(a).toEqual({ kind: "ignore" });
  });

  it("Enter on a regular option still confirms — the chat row shadows nothing", () => {
    const a = routeKey(
      KEY.CONFIRM,
      makeState({ optionIndex: 0 }),
      makeRuntime(single, { currentItem: itemsFor(single[0]!)[0], items: itemsFor(single[0]!) }),
    );
    expect(a.kind).toBe("confirm");
  });
});

describe("reduce — chat_request", () => {
  it("closes with cancelled:true, the marker, and earlier answers kept", () => {
    const q = [makeQuestion()];
    const prior = answer(0, "Pick one", "A");
    const answers = new Map([[0, prior]]);
    const r = reduce(makeState({ answers }), { kind: "chat_request" }, makeCtx({ questions: q }));
    const done = r.effects.find((e): e is Extract<Effect, { kind: "done" }> => e.kind === "done");
    expect(done).toBeDefined();
    expect(done?.result.cancelled).toBe(true);
    expect(done?.result.chatRequested).toEqual({
      questionIndex: 0,
      question: "Pick one",
    });
    expect(done?.result.answers).toEqual([prior]);
  });

  it("keeps the ticked boxes as the current tab's answer on a multi-select tab", () => {
    const q = [makeQuestion({ multiSelect: true })];
    const r = reduce(
      makeState({ multiSelectChecked: new Set([0, 1]) }),
      { kind: "chat_request" },
      makeCtx({ questions: q }),
    );
    const done = r.effects.find(
      (e): e is { kind: "done"; result: QuestionnaireResult } => e.kind === "done",
    );
    expect(done?.result.answers[0]).toMatchObject({
      questionIndex: 0,
      kind: "multi",
      selected: ["A", "B"],
    });
    expect(done?.result.chatRequested).toEqual({ questionIndex: 0, question: "Pick one" });
  });

  it("marks the tab the row was picked on, leaving later tabs unanswered", () => {
    const q = [makeQuestion(), makeQuestion({ question: "Second?" })];
    const first = answer(0, "Pick one", "A");
    const answers = new Map([[0, first]]);
    const r = reduce(
      makeState({ answers, currentTab: 1 }),
      { kind: "chat_request" },
      makeCtx({ questions: q }),
    );
    const done = r.effects.find(
      (e): e is { kind: "done"; result: QuestionnaireResult } => e.kind === "done",
    );
    expect(done?.result.chatRequested).toEqual({ questionIndex: 1, question: "Second?" });
    expect(done?.result.answers).toEqual([first]);
  });

  it("lifts notes like every other close", () => {
    const q = [makeQuestion()];
    const notes = new Map<number, string>([
      [0, "wondering about caching"],
      [1, "global thought"],
    ]);
    const r = reduce(
      makeState({ notesByTab: notes }),
      { kind: "chat_request" },
      makeCtx({ questions: q }),
    );
    const done = r.effects.find(
      (e): e is { kind: "done"; result: QuestionnaireResult } => e.kind === "done",
    );
    expect(done?.result.unansweredNotes).toEqual([
      { questionIndex: 0, question: "Pick one", note: "wondering about caching" },
    ]);
    expect(done?.result.globalNote).toBe("global thought");
  });
});

describe("buildQuestionnaireResponse — chat request", () => {
  const params: QuestionParams = {
    questions: [
      makeQuestion({ question: "Which cache?" }),
      makeQuestion({ question: "Which runtime?" }),
    ],
  };

  it("names the question, keeps the answered segments, and instructs the model to wait", () => {
    const prior = answer(0, "Which cache?", "Redis");
    const result: QuestionnaireResult = {
      answers: [prior],
      cancelled: true,
      chatRequested: { questionIndex: 1, question: "Which runtime?" },
    };
    const out = buildQuestionnaireResponse(result, params);
    expect(out.details.cancelled).toBe(true);
    expect(out.details.chatRequested).toEqual({ questionIndex: 1, question: "Which runtime?" });
    expect(out.content[0]?.text).toContain('question 2 ("Which runtime?")');
    expect(out.content[0]?.text).toContain('"Which cache?"="Redis"');
    expect(out.content[0]?.text).toContain(CHAT_REQUEST_INSTRUCTION);
  });

  it("still produces the chat message when nothing was answered before the pick", () => {
    const result: QuestionnaireResult = {
      answers: [],
      cancelled: true,
      chatRequested: { questionIndex: 0, question: "Which cache?" },
    };
    const out = buildQuestionnaireResponse(result, params);
    expect(out.content[0]?.text).toContain(CHAT_REQUEST_INSTRUCTION);
    expect(out.content[0]?.text).not.toContain("User declined");
  });

  it("never attaches the marker to an ordinary result", () => {
    const result: QuestionnaireResult = {
      answers: [answer(0, "Which cache?", "Redis")],
      cancelled: false,
    };
    const out = buildQuestionnaireResponse(result, params);
    expect("chatRequested" in out.details).toBe(false);
  });
});

describe("rpc fallback — the chat escape", () => {
  function recorder(
    replies: (string | undefined)[],
  ): DialogUI & { selectCalls: string[][]; inputCalls: string[] } {
    const queue = [...replies];
    const selectCalls: string[][] = [];
    const inputCalls: string[] = [];
    return {
      select: (_title, options) => {
        selectCalls.push(options);
        return Promise.resolve(queue.shift());
      },
      input: (_title) => {
        inputCalls.push("");
        return Promise.resolve(queue.shift());
      },
      selectCalls,
      inputCalls,
    };
  }

  it("single-select: the chat row closes with the marker and earlier answers kept", async () => {
    const params: QuestionParams = {
      questions: [
        makeQuestion({ question: "Which cache?" }),
        makeQuestion({ question: "Which runtime?" }),
      ],
    };
    const ui = recorder(["1. A — a", `4. ${ROW_INTENT_META.chat.label}`]);
    const result = await runRpcQuestionnaire(ui, params);
    expect(result.cancelled).toBe(true);
    expect(result.chatRequested).toEqual({ questionIndex: 1, question: "Which runtime?" });
    expect(result.answers[0]?.answer).toBe("A");
  });

  it("multi-select: the word 'chat' closes with the marker", async () => {
    const params: QuestionParams = {
      questions: [makeQuestion({ multiSelect: true, question: "Pick areas" })],
    };
    const ui = recorder(["CHAT"]);
    const result = await runRpcQuestionnaire(ui, params);
    expect(result.cancelled).toBe(true);
    expect(result.chatRequested).toEqual({ questionIndex: 0, question: "Pick areas" });
    expect(result.answers).toEqual([]);
  });

  it("multi-select: a reply containing 'chat' among tokens stays a custom answer", async () => {
    const params: QuestionParams = {
      questions: [makeQuestion({ multiSelect: true, question: "Pick areas" })],
    };
    const ui = recorder(["1, chat"]);
    const result = await runRpcQuestionnaire(ui, params);
    expect(result.cancelled).toBe(false);
    expect("chatRequested" in result).toBe(false);
    expect(result.answers[0]?.kind).toBe("custom");
  });
});
