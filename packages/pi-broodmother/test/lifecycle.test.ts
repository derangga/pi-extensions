import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ChildSessionOptions, CreatedChildSession } from "../src/child.js";
import {
  ACTIVITY_MAX,
  describeToolCall,
  GRACE_TURNS,
  runChildLifecycle,
  truncateResult,
  type ChildRunOptions,
  type TaskProgress,
} from "../src/lifecycle.js";

type Message = AgentSession["messages"][number];

function assistant(text: string, stopReason = "stop", errorMessage?: string): Message {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  } as unknown as Message;
}

function toolStart(toolName: string, args: unknown): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName,
    args,
  } as AgentSessionEvent;
}

function messageEnd(usage: Record<string, number>, cost?: number): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: { ...usage, ...(cost === undefined ? {} : { cost: { total: cost } }) },
    },
  } as unknown as AgentSessionEvent;
}

function turnEnd(message: Message = assistant("")): AgentSessionEvent {
  return { type: "turn_end", message, toolResults: [] } as unknown as AgentSessionEvent;
}

interface FakeControls {
  readonly emit: (event: AgentSessionEvent) => void;
  readonly messages: Message[];
  readonly resolveAbort: () => void;
}

function fakeChild(
  promptRun: (controls: FakeControls) => void | Promise<void>,
  initialMessages: Message[] = [],
) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages = [...initialMessages];
  const order: string[] = [];
  let resolveAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const subscribe = vi.fn<(listener: (event: AgentSessionEvent) => void) => () => boolean>(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  const prompt = vi.fn<() => Promise<void>>(async () => {
    await promptRun({ emit, messages, resolveAbort });
  });
  const steer = vi.fn<() => Promise<void>>(async () => undefined);
  const abort = vi.fn<() => Promise<void>>(async () => resolveAbort());
  const hasHandlers = vi.fn<() => boolean>(() => true);
  const emitShutdown = vi.fn<() => Promise<void>>(async () => {
    order.push("shutdown");
  });
  const dispose = vi.fn<() => void>(() => order.push("dispose"));
  const session = {
    messages,
    sessionFile: "/tmp/child.jsonl",
    subscribe,
    prompt,
    steer,
    abort,
    extensionRunner: {
      hasHandlers,
      emit: emitShutdown,
    },
    dispose,
  } as unknown as AgentSession;
  const created: CreatedChildSession = {
    session,
    sessionFile: session.sessionFile,
    fffLoaded: false,
    notes: [],
  };
  return { abort, aborted, created, dispose, emitShutdown, order, prompt, session, steer };
}

const childOptions = {} as ChildSessionOptions;

function options(
  created: CreatedChildSession,
  overrides: Partial<ChildRunOptions> = {},
): ChildRunOptions {
  return {
    child: childOptions,
    task: "Investigate",
    maxTurns: 10,
    create: async () => created,
    ...overrides,
  };
}

describe("child lifecycle", () => {
  it("returns only output produced by the current invocation and shuts down in order", async () => {
    const fake = fakeChild(
      ({ messages }) => {
        messages.push(assistant("current answer"));
      },
      [assistant("old answer")],
    );

    const result = await Effect.runPromise(runChildLifecycle(options(fake.created)));

    expect(result).toMatchObject({
      outcome: "completed",
      output: "current answer",
      partial: false,
      producedOutput: true,
    });
    expect(result.output).not.toContain("old answer");
    expect(fake.order).toEqual(["shutdown", "dispose"]);
  });

  it("steers once at the soft limit and aborts after the grace turns", async () => {
    const fake = fakeChild(async ({ emit, messages }) => {
      messages.push(assistant("unfinished work"));
      for (let turn = 0; turn < 2 + GRACE_TURNS; turn++) {
        emit(turnEnd());
      }
      await fake.aborted;
      throw new Error("prompt rejected after abort");
    });

    const result = await Effect.runPromise(
      runChildLifecycle(options(fake.created, { maxTurns: 2 })),
    );

    expect(fake.steer).toHaveBeenCalledTimes(1);
    expect(fake.abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "aborted", turns: 2 + GRACE_TURNS, partial: true });
    expect(result.output).toContain("Partial output before termination:\nunfinished work");
  });

  it("reports wrapped_up when the child answers after the soft limit", async () => {
    const fake = fakeChild(({ emit, messages }) => {
      emit(turnEnd());
      messages.push(assistant("wrapped answer"));
    });

    const result = await Effect.runPromise(
      runChildLifecycle(options(fake.created, { maxTurns: 1 })),
    );

    expect(fake.steer).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "wrapped_up", partial: false, turns: 1 });
    expect(result.output).toContain("wrapped answer");
  });

  it("aborts and reports a separate wall-clock timeout", async () => {
    const fake = fakeChild(async () => fake.aborted);

    const result = await Effect.runPromise(
      runChildLifecycle(options(fake.created, { timeoutMs: 1 })),
    );

    expect(result.outcome).toBe("timed_out");
    expect(fake.abort).toHaveBeenCalled();
    expect(fake.order).toEqual(["shutdown", "dispose"]);
  });

  it("maps caller cancellation to stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeChild(async () => fake.aborted);

    const result = await Effect.runPromise(
      runChildLifecycle(options(fake.created, { signal: controller.signal })),
    );

    expect(result.outcome).toBe("stopped");
    expect(fake.abort).toHaveBeenCalled();
  });

  it.each([
    ["error", "provider exploded"],
    ["length", undefined],
  ])("treats a final %s response without usable output as failed", async (reason, error) => {
    const fake = fakeChild(({ messages }) => {
      messages.push(assistant("", reason, error));
    });

    const result = await Effect.runPromise(runChildLifecycle(options(fake.created)));

    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
  });

  it("accepts text truncated by the provider as a completion", async () => {
    const fake = fakeChild(({ messages }) => {
      messages.push(assistant("usable prefix", "length"));
    });

    const result = await Effect.runPromise(runChildLifecycle(options(fake.created)));

    expect(result).toMatchObject({ outcome: "completed", output: "usable prefix" });
  });

  it("salvages current output when prompting rejects", async () => {
    const fake = fakeChild(({ messages }) => {
      messages.push(assistant("work before failure"));
      throw new Error("request failed");
    });

    const result = await Effect.runPromise(runChildLifecycle(options(fake.created)));

    expect(result).toMatchObject({ outcome: "failed", error: "request failed", partial: true });
    expect(result.output).toContain("Partial output before termination:\nwork before failure");
  });

  it("turns creation failures into failed values", async () => {
    const result = await Effect.runPromise(
      runChildLifecycle({
        child: childOptions,
        task: "Investigate",
        maxTurns: 1,
        create: async () => {
          throw new Error("could not start");
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: "failed",
      error: "could not start",
      producedOutput: false,
      turns: 0,
    });
  });
});

describe("result truncation", () => {
  it("caps UTF-8 bytes without splitting a code point and includes the transcript", () => {
    const result = truncateResult("a".repeat(80) + "🙂".repeat(20), "/tmp/full.jsonl", 100);

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
    expect(result).toContain("Full transcript: /tmp/full.jsonl");
    expect(result).not.toContain("�");
  });
});

describe("describeToolCall", () => {
  it("names the tool when there is nothing better to show", () => {
    expect(describeToolCall("read", undefined)).toBe("Read");
    expect(describeToolCall("read", { lines: 12 })).toBe("Read");
  });

  it("prefers the argument a reader cares about over the first one present", () => {
    expect(describeToolCall("grep", { caseSensitive: true, pattern: "useEffect" })).toBe(
      "Grep useEffect",
    );
    expect(describeToolCall("find", { path: "src/index.ts" })).toBe("Find src/index.ts");
  });

  it("falls back to any string when no known key is present", () => {
    expect(describeToolCall("custom", { whatever: "a value" })).toBe("Custom a value");
  });

  it("flattens and truncates so the widget keeps one line per task", () => {
    const described = describeToolCall("grep", { pattern: `line\n  ${"x".repeat(ACTIVITY_MAX)}` });
    expect(described).not.toContain("\n");
    expect(described.endsWith("…")).toBe(true);
  });
});

describe("progress reporting", () => {
  it("counts tool calls and names the last one", async () => {
    const seen: TaskProgress[] = [];
    const fake = fakeChild(({ emit, messages }) => {
      emit(toolStart("grep", { pattern: "useEffect" }));
      emit(toolStart("read", { file_path: "src/index.ts" }));
      messages.push(assistant("done"));
    });

    await Effect.runPromise(
      runChildLifecycle(options(fake.created, { onProgress: (p) => seen.push(p) })),
    );

    expect(seen.at(-1)).toMatchObject({ toolCalls: 2, activity: "Read src/index.ts" });
  });

  it("keeps the work total and the bill apart across turns", async () => {
    const seen: TaskProgress[] = [];
    const fake = fakeChild(({ emit, messages }) => {
      emit(messageEnd({ input: 100, output: 20, cacheWrite: 5, cacheRead: 9_000 }, 0.01));
      emit(messageEnd({ input: 10, output: 2, cacheWrite: 0, cacheRead: 9_000 }, 0.002));
      messages.push(assistant("done"));
    });

    await Effect.runPromise(
      runChildLifecycle(options(fake.created, { onProgress: (p) => seen.push(p) })),
    );

    // Each turn's cacheRead is the whole cached prefix re-read on that call.
    // Summing it states the bill (18137) and overstates the work (137).
    expect(seen.at(-1)).toMatchObject({ tokens: 137, billedTokens: 18_137 });
  });

  it("sums the cost Pi priced and never prices anything itself", async () => {
    const seen: TaskProgress[] = [];
    const fake = fakeChild(({ emit, messages }) => {
      emit(messageEnd({ input: 100, output: 20, cacheWrite: 0, cacheRead: 0 }, 0.01));
      // A model Pi has no rates for reports usage with no cost at all.
      emit(messageEnd({ input: 10, output: 2, cacheWrite: 0, cacheRead: 0 }));
      messages.push(assistant("done"));
    });

    await Effect.runPromise(
      runChildLifecycle(options(fake.created, { onProgress: (p) => seen.push(p) })),
    );

    expect(seen.at(-1)).toMatchObject({ tokens: 132, cost: 0.01 });
  });

  it("does not let a throwing listener strand the child", async () => {
    const fake = fakeChild(({ emit, messages }) => {
      emit(toolStart("grep", { pattern: "x" }));
      messages.push(assistant("done anyway"));
    });

    const result = await Effect.runPromise(
      runChildLifecycle(
        options(fake.created, {
          onProgress: () => {
            throw new Error("the widget blew up");
          },
        }),
      ),
    );

    expect(result).toMatchObject({ outcome: "completed", output: "done anyway" });
  });
});
