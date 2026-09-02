import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_POPUP_TOOL_NAME,
  BEL,
  buildItemsForQuestion,
  DEFAULT_PROMPT_GUIDELINES,
  DEFAULT_PROMPT_SNIPPET,
  DEFAULT_TOOL_DESCRIPTION,
  loadQuestionnaireSession,
  registerAskPopupTool,
} from "../src/ask-user-question.js";
import { ASK_POPUP_BLOCKED_EVENT, ASK_POPUP_PROMPT_EVENT } from "../src/events.js";
import { ROW_INTENT_META } from "../src/state/row-intent.js";
import type { QuestionnaireResult, QuestionParams } from "../src/tool/types.js";
import { type CapturedTool, createMockCtx, createMockPi, type MockCtxOptions } from "./mock-pi.js";

/** What `loadQuestionnaireSession` expects back from its import. */
type SessionModuleShape = Parameters<typeof loadQuestionnaireSession>[0] extends
  | (() => Promise<infer M>)
  | undefined
  ? M
  : never;

/**
 * The tool as Pi sees it: what gets registered, which host path a call takes,
 * and what comes back. The overlay path itself is covered by the factory suite;
 * here the question is routing and envelopes.
 */

function register() {
  const mock = createMockPi();
  registerAskPopupTool(mock.pi);
  const tool = mock.tools.get(ASK_POPUP_TOOL_NAME);
  if (!tool) throw new Error("the tool did not register");
  return { mock, tool };
}

async function run(tool: CapturedTool, params: QuestionParams, options: MockCtxOptions = {}) {
  const { ctx, notices } = createMockCtx(options);
  const result = await tool.execute("call-1", params, undefined, undefined, ctx);
  return { result, details: result.details as QuestionnaireResult, notices };
}

function text(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

const ONE_QUESTION: QuestionParams = {
  questions: [
    {
      question: "Which cache?",
      header: "Cache",
      options: [
        { label: "Redis", description: "shared" },
        { label: "In-process", description: "simple" },
      ],
    },
  ],
};

/** A host that only has the native dialog primitives, answering from a queue. */
function rpcHost(replies: (string | undefined)[]): MockCtxOptions {
  const queue = [...replies];
  return {
    mode: "rpc",
    select: () => Promise.resolve(queue.shift()),
    input: () => Promise.resolve(queue.shift()),
  };
}

/**
 * `process.stdout.isTTY` is a plain data property, and undefined when the test
 * runner's output is piped -- which is to say, always. It has to be defined and
 * removed rather than spied on.
 */
const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

afterEach(() => {
  if (realIsTTY) Object.defineProperty(process.stdout, "isTTY", realIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
});

describe("what gets registered", () => {
  it("registers under the name the reconciler looks for", () => {
    const { tool } = register();
    expect(tool.name).toBe(ASK_POPUP_TOOL_NAME);
    expect(tool.label).toBe("Ask User Question");
  });

  it("is called ask_user_question, spelled out", () => {
    // Asserted as a literal rather than against the constant, which would
    // follow a rename. The name is a published contract: it appears in user
    // settings, in transcripts, and in anything that toggles the tool.
    expect(ASK_POPUP_TOOL_NAME).toBe("ask_user_question");
  });

  it("carries the default guidance when no config overrides it", () => {
    const { tool } = register();
    expect(tool.description).toBe(DEFAULT_TOOL_DESCRIPTION);
    expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
    expect(tool.promptGuidelines).toEqual(DEFAULT_PROMPT_GUIDELINES);
  });

  it("tells the model not to author the reserved labels", () => {
    // The validator rejects them, so the description has to say so or the model
    // will keep writing them and keep getting errors back.
    const { tool } = register();
    expect(tool.description).toContain("reserved labels are rejected");
    expect(tool.description).toContain(ROW_INTENT_META.other.label);
  });

  it("registers the reconciler's before_agent_start handler separately", () => {
    // Registering the tool alone must not attach lifecycle handlers; the entry
    // point wires both, and mixing them would make either untestable.
    const { mock } = register();
    expect(mock.handlers.has("before_agent_start")).toBe(false);
  });
});

describe("guidance from config", () => {
  // `getAgentDir()` reads this on every call, so pointing it at a temp
  // directory is enough to give the loader a config file to find.
  const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
  const roots: string[] = [];
  const realAgentDir = process.env[AGENT_DIR_ENV];

  function withGlobalConfig(body: unknown): void {
    const root = mkdtempSync(join(tmpdir(), "pi-ask-popup-guidance-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "pi-ask-popup.json"), JSON.stringify(body));
    process.env[AGENT_DIR_ENV] = root;
  }

  afterEach(() => {
    if (realAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = realAgentDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("lets an operator replace the tool description", () => {
    withGlobalConfig({ guidance: { description: "Ask the human. Politely." } });
    expect(register().tool.description).toBe("Ask the human. Politely.");
  });

  it("lets them replace the prompt snippet and guidelines independently", () => {
    withGlobalConfig({ guidance: { promptSnippet: "ask first", promptGuidelines: ["one"] } });
    const { tool } = register();
    expect(tool.promptSnippet).toBe("ask first");
    expect(tool.promptGuidelines).toEqual(["one"]);
    // Untouched fields keep their defaults rather than emptying out.
    expect(tool.description).toBe(DEFAULT_TOOL_DESCRIPTION);
  });

  it("ignores an unusable override rather than registering an empty description", () => {
    withGlobalConfig({ guidance: { description: "" } });
    expect(register().tool.description).toBe(DEFAULT_TOOL_DESCRIPTION);
  });

  it("reports a malformed config once, on first use", async () => {
    // Registration has no UI to report to, so the warning waits for one.
    // Silently ignoring a file someone wrote makes the setting look broken
    // rather than mistyped.
    const root = mkdtempSync(join(tmpdir(), "pi-ask-popup-guidance-"));
    roots.push(root);
    writeFileSync(join(root, "pi-ask-popup.json"), "{ not json");
    process.env[AGENT_DIR_ENV] = root;

    const { tool } = register();
    const first = await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(first.notices.some((n) => n.level === "warning")).toBe(true);
    const second = await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(second.notices).toEqual([]);
  });
});

describe("hosts that cannot show anything", () => {
  it("refuses without a UI and says why", async () => {
    const { tool } = register();
    const { result, details } = await run(tool, ONE_QUESTION, { hasUI: false });
    expect(details.error).toBe("no_ui");
    expect(details.cancelled).toBe(true);
    expect(text(result)).toContain("non-interactive");
  });

  it("emits no events when it never asked", async () => {
    // A prompt event for a questionnaire nobody saw would be a lie to every
    // listener downstream.
    const { mock, tool } = register();
    await run(tool, ONE_QUESTION, { hasUI: false });
    expect(mock.events).toEqual([]);
  });

  it("tells the model a host without custom UI never showed the questions", async () => {
    // The distinction that matters most in this file: not asked is not the same
    // as declined, and the model must not read one as the other.
    const { tool } = register();
    const { result, details } = await run(tool, ONE_QUESTION, {
      custom: () => Promise.resolve(undefined),
    });
    expect(details.error).toBe("no_custom_ui");
    expect(text(result)).toContain("never saw the questions");
    expect(text(result)).toContain("do NOT treat this as a decline");
  });
});

describe("validation", () => {
  it("rejects a questionnaire with no questions", async () => {
    const { tool } = register();
    const { details } = await run(tool, { questions: [] });
    expect(details.error).toBe("no_questions");
  });

  it("rejects a reserved option label", async () => {
    const { tool } = register();
    const { details } = await run(tool, {
      questions: [
        {
          question: "q",
          header: "h",
          options: [
            { label: ROW_INTENT_META.other.label, description: "d" },
            { label: "B", description: "b" },
          ],
        },
      ],
    });
    expect(details.error).toBe("reserved_label");
  });

  it("rejects before emitting anything", async () => {
    // Same reason as the no-UI case: nothing was asked.
    const { mock, tool } = register();
    await run(tool, { questions: [] });
    expect(mock.events).toEqual([]);
  });
});

describe("routing to the native dialogs", () => {
  it("uses them on a host that advertises RPC mode", async () => {
    const { tool } = register();
    const { details } = await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(details.cancelled).toBe(false);
    expect(details.answers[0]).toMatchObject({ answer: "Redis" });
  });

  it("never touches the overlay on that path", async () => {
    // Skipping it means the render graph is never imported at all on a host
    // that could not have used it.
    const custom = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));
    const { tool } = register();
    await run(tool, ONE_QUESTION, { ...rpcHost(["1. Redis — shared"]), custom });
    expect(custom).not.toHaveBeenCalled();
  });

  it("falls back to them when an older host renders nothing", async () => {
    // RPC builds too old to advertise their mode land here: `custom` resolves
    // undefined, and the primitives still work.
    const { tool } = register();
    const { details } = await run(tool, ONE_QUESTION, {
      custom: () => Promise.resolve(undefined),
      select: () => Promise.resolve("1. Redis — shared"),
      input: () => Promise.resolve(undefined),
    });
    expect(details.answers[0]).toMatchObject({ answer: "Redis" });
  });

  it("does not take that route on an RPC host lacking the primitives", async () => {
    // The mode alone is not enough. Routing there without checking would call
    // select on a host that has none, and the crash would surface to the model
    // as a broken tool rather than an unsupported one.
    const { tool } = register();
    const { details } = await run(tool, ONE_QUESTION, { mode: "rpc" });
    expect(details.error).toBe("no_custom_ui");
  });

  it("reports a real decline from the native dialogs as a decline", async () => {
    const { tool } = register();
    const { details } = await run(tool, ONE_QUESTION, rpcHost([undefined]));
    expect(details.cancelled).toBe(true);
    expect(details.error).toBeUndefined();
  });
});

describe("events", () => {
  it("describes the questionnaire as it goes up", async () => {
    const { mock, tool } = register();
    await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    const prompt = mock.events.find((e) => e.channel === ASK_POPUP_PROMPT_EVENT);
    expect(prompt?.payload).toMatchObject({
      questions: [{ header: "Cache", multiSelect: false }],
    });
  });

  it("brackets the wait with blocked true and false", async () => {
    const { mock, tool } = register();
    await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    const blocked = mock.events.filter((e) => e.channel === ASK_POPUP_BLOCKED_EVENT);
    expect(blocked.map((e) => e.payload)).toEqual([{ active: true }, { active: false }]);
  });

  it("clears blocked even when the dialogs throw", async () => {
    // The false lives in a finally precisely for this: a listener stuck showing
    // that the agent is waiting, forever, is the worst outcome here.
    const { mock, tool } = register();
    await expect(
      run(tool, ONE_QUESTION, {
        mode: "rpc",
        select: () => Promise.reject(new Error("host exploded")),
        input: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow("host exploded");
    const blocked = mock.events.filter((e) => e.channel === ASK_POPUP_BLOCKED_EVENT);
    expect(blocked.at(-1)?.payload).toEqual({ active: false });
  });

  it("says blocked before it rings, so a listener sees the cause first", async () => {
    const order: string[] = [];
    setIsTTY(true);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (chunk === BEL) order.push("bell");
      return true;
    });
    const mock = createMockPi();
    registerAskPopupTool(mock.pi);
    const tool = mock.tools.get(ASK_POPUP_TOOL_NAME) as CapturedTool;
    const originalEmit = mock.pi.events.emit.bind(mock.pi.events);
    vi.spyOn(mock.pi.events, "emit").mockImplementation((channel: string, payload: unknown) => {
      if (channel === ASK_POPUP_BLOCKED_EVENT)
        order.push(`blocked:${String((payload as { active: boolean }).active)}`);
      return originalEmit(channel, payload);
    });
    await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(order).toEqual(["blocked:true", "bell", "blocked:false"]);
  });
});

describe("the terminal bell", () => {
  it("rings once on a real terminal", async () => {
    setIsTTY(true);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { tool } = register();
    await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(write.mock.calls.filter((c) => c[0] === BEL)).toHaveLength(1);
  });

  it("stays silent when stdout is not a terminal", async () => {
    // Writing to a piped RPC transport would ring the local machine for a
    // dialog rendering in a remote host's own window.
    setIsTTY(false);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { tool } = register();
    await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(write.mock.calls.filter((c) => c[0] === BEL)).toHaveLength(0);
  });

  it("asks the questions anyway when the write fails", async () => {
    setIsTTY(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const { tool } = register();
    const { details } = await run(tool, ONE_QUESTION, rpcHost(["1. Redis — shared"]));
    expect(details.answers[0]).toMatchObject({ answer: "Redis" });
  });
});

describe("loading the render graph", () => {
  it("resolves the session module in the normal case", async () => {
    const load = await loadQuestionnaireSession();
    expect(load.ok).toBe(true);
  });

  it("reports a failed import as something the user never saw", async () => {
    // Pi's loader caches a module before evaluating it and does not evict it
    // when evaluation throws, so a dependency replaced on disk mid-session
    // poisons every later import of this specifier.
    const load = await loadQuestionnaireSession(() =>
      Promise.reject(new Error("ENOENT: store entry vanished")),
    );
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error).toBe("session_load_failed");
    expect(load.message).toContain("never saw the questions");
    expect(load.message).toContain("do NOT treat this as a decline");
    // The cause travels with it: "the UI failed to load" alone gives whoever
    // reads the transcript nothing to act on.
    expect(load.message).toContain("ENOENT: store entry vanished");
  });

  it("reports a module that resolved without its class as needing a restart", async () => {
    // The second shape of the same fault: the import succeeds, and what comes
    // back is the hollow namespace the earlier failure left behind. That state
    // cannot be repaired inside the process, so the message has to say so.
    const load = await loadQuestionnaireSession(() =>
      Promise.resolve({} as unknown as SessionModuleShape),
    );
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error).toBe("stale_module_cache");
    expect(load.message).toContain("restart Pi");
    expect(load.message).toContain("do NOT treat this as a decline");
  });

  it("keeps the two failures distinct, since one is recoverable and one is not", async () => {
    const failed = await loadQuestionnaireSession(() => Promise.reject(new Error("x")));
    const stale = await loadQuestionnaireSession(() =>
      Promise.resolve({} as unknown as SessionModuleShape),
    );
    expect(failed.ok || stale.ok).toBe(false);
    if (failed.ok || stale.ok) return;
    expect(failed.error).not.toBe(stale.error);
    expect(stale.message).toContain("restart");
    expect(failed.message).not.toContain("restart Pi to restore");
  });
});

describe("buildItemsForQuestion", () => {
  it("appends the custom-answer row to a single-select question", () => {
    const question = ONE_QUESTION.questions[0];
    if (!question) throw new Error("fixture");
    const items = buildItemsForQuestion(question);
    expect(items.map((i) => i.kind)).toEqual(["option", "option", "other"]);
    expect(items.at(-1)?.label).toBe(ROW_INTENT_META.other.label);
  });

  it("appends the commit row too when several answers are allowed", () => {
    const question = ONE_QUESTION.questions[0];
    if (!question) throw new Error("fixture");
    const items = buildItemsForQuestion({ ...question, multiSelect: true });
    expect(items.map((i) => i.kind)).toEqual(["option", "option", "other", "next"]);
  });

  it("carries each option's description onto its row", () => {
    const question = ONE_QUESTION.questions[0];
    if (!question) throw new Error("fixture");
    expect(buildItemsForQuestion(question)[0]).toEqual({
      kind: "option",
      label: "Redis",
      description: "shared",
    });
  });
});
