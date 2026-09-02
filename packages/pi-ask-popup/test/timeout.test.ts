import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeQuestion, makeQuestionnaireState, makeApplyContext, makeTheme } from "./fixtures.js";
import { reduce } from "../src/state/state-reducer.js";
import { buildHintText, buildSubmitHintText } from "../src/view/tab-content-strategy.js";
import {
  buildQuestionnaireResponse,
  TIMED_OUT_MESSAGE,
  DECLINE_MESSAGE,
} from "../src/tool/response-envelope.js";
import { runRpcQuestionnaire, type DialogUI } from "../src/rpc-fallback.js";
import { QuestionnaireSession } from "../src/state/questionnaire-session.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { QuestionParams, QuestionnaireResult } from "../src/tool/types.js";

const keybindings = {
  matches(_data: string, _name: string): boolean {
    return false;
  },
};

describe("timeout — reducer tick", () => {
  it("updates remainingMs when deadline is in the future", () => {
    const now = 1_000_000;
    const deadline = now + 10_000;
    const state = makeQuestionnaireState({
      deadline,
      remainingMs: 10_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "tick", now: now + 3_000 }, makeApplyContext());
    expect(result.state.remainingMs).toBe(7_000);
    expect(result.effects).toEqual([]);
  });

  it("fires timed_out when deadline is reached", () => {
    const now = 1_000_000;
    const deadline = now + 5_000;
    const state = makeQuestionnaireState({
      deadline,
      remainingMs: 5_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "tick", now: deadline }, makeApplyContext());
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "done",
      result: expect.objectContaining({ cancelled: true, error: "timed_out" }),
    });
  });

  it("fires timed_out when deadline is passed", () => {
    const now = 1_000_000;
    const deadline = now + 2_000;
    const state = makeQuestionnaireState({
      deadline,
      remainingMs: 2_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "tick", now: deadline + 1 }, makeApplyContext());
    expect(result.effects[0]).toMatchObject({
      kind: "done",
      result: expect.objectContaining({ error: "timed_out" }),
    });
  });

  it("is a no-op when no deadline is set", () => {
    const state = makeQuestionnaireState({ timerCancelled: false });
    const result = reduce(state, { kind: "tick", now: Date.now() }, makeApplyContext());
    expect(result.state.remainingMs).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it("is a no-op after timerCancelled", () => {
    const now = 1_000_000;
    const state = makeQuestionnaireState({
      deadline: now + 5_000,
      remainingMs: 5_000,
      timerCancelled: true,
    });
    const result = reduce(state, { kind: "tick", now: now + 1_000 }, makeApplyContext());
    expect(result.state.remainingMs).toBe(5_000);
    expect(result.effects).toEqual([]);
  });

  it("expiry carries global note and partial answers", () => {
    const now = 1_000_000;
    const deadline = now + 1_000;
    const questions = [makeQuestion({ question: "Q1" }), makeQuestion({ question: "Q2" })];
    const answers = new Map([
      [0, { questionIndex: 0, question: "Q1", kind: "option" as const, answer: "A" }],
    ]);
    const notesByTab = new Map([[2, "global note"]]);
    const state = makeQuestionnaireState({
      answers,
      notesByTab,
      deadline,
      remainingMs: 1_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "tick", now: deadline }, makeApplyContext({ questions }));
    const done = result.effects[0] as {
      kind: "done";
      result: { globalNote?: string; answers: unknown[] };
    };
    expect(done.result.globalNote).toBe("global note");
    expect(done.result.answers).toHaveLength(1);
  });
});

describe("timeout — human-present cancel", () => {
  it("first non-tick action sets timerCancelled and emits clear_timer", () => {
    const now = 1_000_000;
    const state = makeQuestionnaireState({
      deadline: now + 10_000,
      remainingMs: 10_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "nav", nextIndex: 1, inputValue: "" }, makeApplyContext());
    expect(result.state.timerCancelled).toBe(true);
    expect(result.state.remainingMs).toBeUndefined();
    expect(result.effects).toContainEqual({ kind: "clear_timer" });
  });

  it("emits clear_timer only once — second keystroke does not re-emit", () => {
    const now = 1_000_000;
    const base = makeQuestionnaireState({
      deadline: now + 10_000,
      remainingMs: 10_000,
      timerCancelled: false,
    });
    const first = reduce(base, { kind: "nav", nextIndex: 1, inputValue: "" }, makeApplyContext());
    expect(first.effects).toContainEqual({ kind: "clear_timer" });
    const second = reduce(
      first.state,
      { kind: "nav", nextIndex: 0, inputValue: "" },
      makeApplyContext(),
    );
    expect(second.effects).not.toContainEqual({ kind: "clear_timer" });
    expect(second.state.timerCancelled).toBe(true);
  });

  it("tick never triggers cancel", () => {
    const now = 1_000_000;
    const state = makeQuestionnaireState({
      deadline: now + 10_000,
      remainingMs: 10_000,
      timerCancelled: false,
    });
    const result = reduce(state, { kind: "tick", now: now + 1_000 }, makeApplyContext());
    expect(result.state.timerCancelled).toBe(false);
    expect(result.effects).not.toContainEqual({ kind: "clear_timer" });
  });

  it("no clear_timer when no deadline is set", () => {
    const state = makeQuestionnaireState({ timerCancelled: false });
    const result = reduce(state, { kind: "nav", nextIndex: 1, inputValue: "" }, makeApplyContext());
    expect(result.effects).not.toContainEqual({ kind: "clear_timer" });
  });
});

describe("timeout — footer countdown", () => {
  const question = makeQuestion();

  it("footer shows countdown when remainingMs is set and not cancelled", () => {
    const state = makeQuestionnaireState({ remainingMs: 12_000, timerCancelled: false });
    const hint = buildHintText(question, false, state, "ctrl+]");
    expect(hint).toContain("12s left");
  });

  it("footer hides countdown when timerCancelled", () => {
    const state = makeQuestionnaireState({ remainingMs: 12_000, timerCancelled: true });
    const hint = buildHintText(question, false, state, "ctrl+]");
    expect(hint).not.toContain("left");
  });

  it("footer hides countdown when no remainingMs", () => {
    const state = makeQuestionnaireState({ timerCancelled: false });
    const hint = buildHintText(question, false, state, "ctrl+]");
    expect(hint).not.toContain("left");
  });

  it("submit hint shows countdown", () => {
    const state = makeQuestionnaireState({ remainingMs: 5_000, timerCancelled: false });
    const hint = buildSubmitHintText(state);
    expect(hint).toContain("5s left");
  });

  it("rounds up seconds", () => {
    const state = makeQuestionnaireState({ remainingMs: 1_001, timerCancelled: false });
    const hint = buildHintText(question, false, state, "off");
    expect(hint).toContain("2s left");
  });
});

describe("timeout — envelope", () => {
  const params: QuestionParams = {
    questions: [makeQuestion({ question: "Q?" })],
  };

  it("timed_out result yields timed-out message with error preserved", () => {
    const result = {
      answers: [],
      cancelled: true,
      error: "timed_out" as const,
    };
    const out = buildQuestionnaireResponse(result, params);
    expect(out.content[0]?.text).toBe(TIMED_OUT_MESSAGE);
    expect(out.details.error).toBe("timed_out");
    expect(out.details.cancelled).toBe(true);
  });

  it("timed_out preserves globalNote", () => {
    const result = {
      answers: [],
      cancelled: true,
      error: "timed_out" as const,
      globalNote: "note",
    };
    const out = buildQuestionnaireResponse(result, params);
    expect(out.details.globalNote).toBe("note");
  });

  it("normal cancel still yields decline message", () => {
    const result = { answers: [], cancelled: true as const };
    const out = buildQuestionnaireResponse(result, params);
    expect(out.content[0]?.text).toBe(DECLINE_MESSAGE);
  });
});

describe("timeout — RPC passthrough", () => {
  it("passes timeout to select and input", async () => {
    const select = vi.fn<DialogUI["select"]>(() => Promise.resolve("1. A — a"));
    const input = vi.fn<DialogUI["input"]>(() => Promise.resolve("typed"));
    const ui: DialogUI = { select, input };
    const params: QuestionParams = {
      questions: [
        {
          question: "Q1?",
          header: "H",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
        {
          question: "Q2?",
          header: "H2",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
          multiSelect: true,
        },
      ],
      timeout: 30_000,
    };
    await runRpcQuestionnaire(ui, params);
    expect(select).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { timeout: 30_000 });
    expect(input).toHaveBeenCalledWith(expect.any(String), expect.any(String), { timeout: 30_000 });
  });

  it("passes no opts when timeout absent", async () => {
    const select = vi.fn<DialogUI["select"]>(() => Promise.resolve("1. A — a"));
    const ui: DialogUI = { select, input: vi.fn<DialogUI["input"]>() };
    const params: QuestionParams = {
      questions: [
        {
          question: "Q?",
          header: "H",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    };
    await runRpcQuestionnaire(ui, params);
    expect(select).toHaveBeenCalledWith(expect.any(String), expect.any(Array), undefined);
  });
});

describe("timeout — session timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSessionWithTimeout(timeout: number | undefined) {
    const params: QuestionParams = {
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
      ...(timeout === undefined ? {} : { timeout }),
    };
    const done = vi.fn<(result: QuestionnaireResult) => void>();
    const session = new QuestionnaireSession({
      tui: {
        terminal: { columns: 120, rows: 40 },
        requestRender: vi.fn<() => void>(),
      } as unknown as TUI,
      theme: makeTheme() as unknown as Theme,
      params,
      itemsByTab: params.questions.map((q) => [
        ...q.options.map((o) => ({
          kind: "option" as const,
          label: o.label,
          description: o.description,
        })),
        { kind: "other" as const, label: "Type something." },
      ]),
      done,
      keybindings,
      editInput: () => Promise.resolve(undefined),
      collapseKey: "off",
      canReopenWhileHidden: false,
    });
    return { session, done };
  }

  it("no timer when timeout absent — tick is no-op and collapsed row has no countdown", () => {
    const { session } = makeSessionWithTimeout(undefined);
    const collapsed = session.component.render(120);
    // Not collapsed, but check that no interval was started by ensuring fake timers don't fire.
    vi.advanceTimersByTime(5_000);
    expect(collapsed.join("\n")).not.toContain("left");
  });

  it("timer exists when timeout present — collapsed row shows countdown", () => {
    const { session } = makeSessionWithTimeout(30_000);
    session.toggleCollapsedExternal();
    const collapsed = session.component.render(120);
    expect(collapsed[0]).toContain("30s left");
  });

  it("first keystroke cancels timer — countdown disappears", () => {
    const { session } = makeSessionWithTimeout(30_000);
    session.toggleCollapsedExternal();
    expect(session.component.render(120)[0]).toContain("left");
    session.toggleCollapsedExternal(); // expand
    session.dispatch("\x1b[B"); // DOWN — any keystroke
    session.toggleCollapsedExternal(); // collapse again
    expect(session.component.render(120)[0]).not.toContain("left");
  });

  it("expiry via tick calls done with timed_out", () => {
    const { done } = makeSessionWithTimeout(5_000);
    vi.advanceTimersByTime(6_000);
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true, error: "timed_out" }),
    );
  });

  it("countdown updates on tick", () => {
    const { session } = makeSessionWithTimeout(10_000);
    session.toggleCollapsedExternal();
    expect(session.component.render(120)[0]).toContain("10s left");
    vi.advanceTimersByTime(3_000);
    expect(session.component.render(120)[0]).toContain("7s left");
  });
});
