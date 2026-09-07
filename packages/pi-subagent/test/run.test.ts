import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { ChildSessionOptions } from "../src/child.js";
import { Intercom, type ParentDeliveryMode } from "../src/intercom.js";
import type { ChildFactory } from "../src/lifecycle.js";
import type { ModelSource } from "../src/resolve.js";
import {
  formatManagerError,
  Manager,
  type RunView,
  type StartRequest,
  type TaskRequest,
} from "../src/run.js";
import { DEFAULT_SETTINGS, Settings, type SubagentSettings } from "../src/settings.js";
import type { PiModel } from "../src/thinking.js";

const model = {
  provider: "anthropic",
  id: "claude-opus-5",
  name: "Opus",
  reasoning: true,
} as unknown as PiModel;

function source(): ModelSource {
  return { available: () => [model], probe: async () => undefined };
}

function settingsLayer(overrides: Partial<SubagentSettings> = {}) {
  const value: SubagentSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return Layer.succeed(
    Settings,
    Settings.of({
      current: Effect.succeed(value),
      warnings: [],
      path: "/dev/null",
      update: () => Effect.void,
    }),
  );
}

interface Sent {
  readonly message: string;
  readonly mode: ParentDeliveryMode;
}

/**
 * The R swap. Everything the manager talks to is here: an in-memory settings
 * file, a delivery channel that collects rather than sends, and a child factory
 * that answers from a table instead of starting a session.
 */
function layers(
  sent: Sent[],
  overrides: Partial<SubagentSettings> = {},
  onChange?: (runs: readonly RunView[]) => void,
) {
  return Manager.layer(onChange ? { onChange } : {}).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        settingsLayer(overrides),
        Intercom.layer(
          { send: (message, mode) => sent.push({ message, mode }) },
          // Short enough that a forgotten reply cannot hang the suite.
          200,
        ),
      ),
    ),
  );
}

type Answer = (prompt: string, options: ChildSessionOptions) => Promise<string> | string;

/** A child that replies with one assistant message and nothing else. */
function childFactory(answer: Answer): ChildFactory {
  return async (options: ChildSessionOptions) => {
    const messages: AgentSession["messages"][number][] = [];
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const session = {
      messages,
      sessionFile: `/sessions/${options.name}.jsonl`,
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async (task: string) => {
        for (const listener of listeners) {
          listener({
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "grep",
            args: { pattern: "useEffect" },
          } as AgentSessionEvent);
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              usage: { input: 90, output: 10, cacheWrite: 0, cacheRead: 5_000 },
            },
          } as unknown as AgentSessionEvent);
        }
        const text = await answer(task, options);
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        } as unknown as AgentSession["messages"][number]);
      },
      steer: async () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    };
    return {
      session: session as unknown as Awaited<ReturnType<ChildFactory>>["session"],
      sessionFile: session.sessionFile,
      fffLoaded: false,
      notes: [],
    };
  };
}

function task(fields: Partial<TaskRequest> = {}): TaskRequest {
  return { agent: "a reader", task: "read", prompt: "read the thing", ...fields };
}

function request(
  tasks: readonly TaskRequest[],
  create: ChildFactory,
  overrides: Partial<StartRequest> = {},
): StartRequest {
  return {
    tasks,
    cwd: "/repo",
    parent: { model, thinking: "off" },
    parentSession: "/sessions/parent.jsonl",
    source: source(),
    create,
    ...overrides,
  };
}

/** Runs one program against a fresh manager and tears the layer down after. */
function withManager<A, E>(
  sent: Sent[],
  program: (manager: Manager["Service"]) => Effect.Effect<A, E>,
  overrides: Partial<SubagentSettings> = {},
  onChange?: (runs: readonly RunView[]) => void,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* Manager;
      return yield* program(manager);
    }).pipe(Effect.provide(layers(sent, overrides, onChange))),
  );
}

function outputs(run: RunView): Record<string, string | undefined> {
  return Object.fromEntries(run.tasks.map((entry) => [entry.id, entry.output?.trim()]));
}

describe("Manager.start", () => {
  it("runs an edgeless batch in parallel and reports every output", async () => {
    const sent: Sent[] = [];
    const run = await withManager(sent, (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a", prompt: "one" }), task({ id: "b", prompt: "two" })],
            childFactory((prompt) => `answered ${prompt}`),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    expect(run.finished).toBe(true);
    expect(run.tasks.map((entry) => entry.wave)).toEqual([0, 0]);
    expect(outputs(run)).toEqual({ a: "answered one", b: "answered two" });
    expect(run.tasks.map((entry) => entry.sessionFile)).toEqual([
      "/sessions/read.jsonl",
      "/sessions/read.jsonl",
    ]);
  });

  it("prepends an upstream output into its dependent's prompt", async () => {
    const seen: string[] = [];
    const run = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [
              task({ id: "up", prompt: "gather" }),
              task({ id: "down", needs: ["up"], prompt: "use {previous}" }),
            ],
            childFactory((prompt) => {
              seen.push(prompt);
              return prompt.startsWith("gather") ? "THE FACT" : "synthesised";
            }),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    expect(run.tasks.map((entry) => entry.wave)).toEqual([0, 1]);
    expect(seen[1]).toContain("## Output of up");
    expect(seen[1]).toContain("use THE FACT");
    expect(outputs(run).down).toBe("synthesised");
  });

  it("skips a dependent when its upstream produced nothing", async () => {
    const run = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "up", prompt: "gather" }), task({ id: "down", needs: ["up"] })],
            childFactory((prompt) => (prompt.startsWith("gather") ? "" : "should not run")),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    const down = run.tasks.find((entry) => entry.id === "down")!;
    expect(down.status).toBe("skipped");
    expect(down.missing).toEqual(["up"]);
    expect(down.output).toBeUndefined();
  });

  it("refuses a cyclic graph without starting anything", async () => {
    const sent: Sent[] = [];
    const message = await withManager(sent, (manager) =>
      manager
        .start(
          request(
            [task({ id: "a", needs: ["b"] }), task({ id: "b", needs: ["a"] })],
            childFactory(() => "never"),
          ),
        )
        .pipe(Effect.flip, Effect.map(formatManagerError)),
    );

    expect(message).toContain("cycle");
    expect(sent).toEqual([]);
  });

  it("refuses a thinking level the chosen model does not support", async () => {
    const message = await withManager([], (manager) =>
      manager
        .start(
          request(
            [task({ thinking: "max" })],
            childFactory(() => "never"),
          ),
        )
        .pipe(Effect.flip, Effect.map(formatManagerError)),
    );

    expect(message).toContain("not supported");
  });
});

describe("Manager.wait", () => {
  it("returns a child's question rather than making the parent stop waiting", async () => {
    const outcome = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(async (_prompt, options) => {
              const ask = options.customTools?.find((tool) => tool.name === "ask_parent");
              const reply = await ask!.execute(
                "call-1",
                { question: "which branch?" },
                undefined,
                undefined,
                undefined as never,
              );
              const answer = reply.content[0];
              return answer?.type === "text" ? answer.text : "";
            }),
          ),
        );
        return yield* manager.wait(started.id, undefined);
      }),
    );

    expect(outcome.kind).toBe("traffic");
    if (outcome.kind !== "traffic") return;
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]).toMatchObject({ kind: "ask", text: "which branch?" });
  });

  it("resumes a waiting child with the parent's reply", async () => {
    const run = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(async (_prompt, options) => {
              const ask = options.customTools?.find((tool) => tool.name === "ask_parent");
              const reply = await ask!.execute(
                "call-1",
                { question: "which branch?" },
                undefined,
                undefined,
                undefined as never,
              );
              const answer = reply.content[0];
              return `used ${answer?.type === "text" ? answer.text : ""}`;
            }),
          ),
        );
        // The first wait is what surfaces the question; answering it here is
        // the whole round trip the parked queue exists for.
        yield* manager.wait(started.id, undefined);
        expect(yield* manager.reply(started.id, "a", "the master branch")).toBe("delivered");
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    expect(outputs(run).a).toBe("used the master branch");
  });

  it("reports a run that already settled without parking", async () => {
    const outcome = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(() => "done"),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.wait(started.id, undefined);
      }),
    );

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.run.finished).toBe(true);
  });
});

describe("Manager.cancel", () => {
  it("stops the tasks that have not started and keeps what settled", async () => {
    const run = await withManager(
      [],
      (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start(
            request(
              [
                task({ id: "up", prompt: "gather" }),
                task({ id: "down", needs: ["up"], prompt: "use it" }),
              ],
              childFactory((prompt) => (prompt.startsWith("gather") ? "THE FACT" : "should stop")),
            ),
          );
          // The upstream settles first, so cancelling here is the wave boundary.
          yield* manager.wait(started.id, "up");
          yield* manager.cancel(started.id);
          yield* manager.wait(started.id, undefined);
          return yield* manager.view(started.id);
        }),
      { concurrency: 1 },
    );

    expect(run.cancelled).toBe(true);
    expect(outputs(run).up).toBe("THE FACT");
    const down = run.tasks.find((entry) => entry.id === "down")!;
    expect(down.outcome).toBe("stopped");
    expect(down.sessionFile).toBeUndefined();
  });
});

describe("addressing", () => {
  it("defaults to the newest run", async () => {
    const view = await withManager([], (manager) =>
      Effect.gen(function* () {
        yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(() => "first"),
          ),
        );
        const second = yield* manager.start(
          request(
            [task({ id: "b" })],
            childFactory(() => "second"),
          ),
        );
        yield* manager.wait(undefined, undefined);
        const latest = yield* manager.view(undefined);
        expect(latest.id).toBe(second.id);
        return latest;
      }),
    );

    expect(view.tasks.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("names the known runs when asked for one that does not exist", async () => {
    const message = await withManager([], (manager) =>
      Effect.gen(function* () {
        yield* manager.start(
          request(
            [task()],
            childFactory(() => "x"),
          ),
        );
        return yield* manager.view("run_9").pipe(Effect.flip, Effect.map(formatManagerError));
      }),
    );

    expect(message).toContain("run_1");
  });

  it("names the run's tasks when asked to reply to one that does not exist", async () => {
    const message = await withManager([], (manager) =>
      Effect.gen(function* () {
        yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(() => "x"),
          ),
        );
        return yield* manager
          .reply(undefined, "nope", "hello")
          .pipe(Effect.flip, Effect.map(formatManagerError));
      }),
    );

    expect(message).toContain('has no task "nope"');
    expect(message).toContain("a");
  });
});

describe("live progress", () => {
  it("carries each child's tool count, tokens and last activity onto the view", async () => {
    const run = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a" })],
            childFactory(() => "done"),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    const view = run.tasks[0]!;
    expect(view.toolCalls).toBe(1);
    // cacheRead is deliberately absent: 90 + 10 + 0, not 5100.
    expect(view.tokens).toBe(100);
    expect(view.activity).toBe("Grep useEffect");
    expect(view.startedAt).toBeDefined();
    expect(view.endedAt).toBeDefined();
  });

  it("pushes a snapshot on every change, and the last one is the settled run", async () => {
    const seen: RunView[][] = [];
    await withManager(
      [],
      (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start(
            request(
              [task({ id: "a" })],
              childFactory(() => "done"),
            ),
          );
          yield* manager.wait(started.id, undefined);
        }),
      {},
      (runs) => seen.push(runs.map((run) => run)),
    );

    // Start, running, two progress ticks, settle, finish: the widget cannot be
    // driven by polling, so every one of these has to arrive.
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen[0]?.[0]?.tasks[0]?.status).toBe("pending");
    expect(seen.at(-1)?.[0]?.finished).toBe(true);
  });

  it("keeps running when a surface throws", async () => {
    const run = await withManager(
      [],
      (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start(
            request(
              [task({ id: "a" })],
              childFactory(() => "done"),
            ),
          );
          yield* manager.wait(started.id, undefined);
          return yield* manager.view(started.id);
        }),
      {},
      () => {
        throw new Error("the widget blew up");
      },
    );

    expect(outputs(run).a).toBe("done");
  });
});
