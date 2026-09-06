import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ChildSessionOptions, CreatedChildSession } from "../src/child.js";
import {
  GRACE_TURNS,
  runChildLifecycle,
  truncateResult,
  type ChildRunOptions,
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
    for (const listener of listeners) listener(event);
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
    });
    expect(result.output).not.toContain("old answer");
    expect(fake.order).toEqual(["shutdown", "dispose"]);
  });

  it("steers once at the soft limit and aborts after the grace turns", async () => {
    const fake = fakeChild(async ({ emit, messages }) => {
      messages.push(assistant("unfinished work"));
      for (let turn = 0; turn < 2 + GRACE_TURNS; turn++) emit(turnEnd());
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

    expect(result).toMatchObject({ outcome: "failed", error: "could not start", turns: 0 });
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
