import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { loadAgentFile } from "../src/agent-file.js";
import type * as agentFileModule from "../src/agent-file.js";
import type { ChildSessionOptions } from "../src/child.js";
import { Intercom, type ParentDeliveryMode, ParentDelivery } from "../src/intercom.js";
import type { ChildFactory } from "../src/lifecycle.js";
import type { ModelSource } from "../src/resolve.js";
import {
  aggregateUsage,
  EVENT_RUN_SETTLED,
  EVENT_RUN_STARTED,
  EVENT_TASK_SETTLED,
  formatManagerError,
  Manager,
  ManagerSurfaces,
  type RunView,
  type StartRequest,
  type SubagentEvent,
  type TaskRequest,
} from "../src/run.js";
import { DEFAULT_SETTINGS, Settings, type SubagentSettings } from "../src/settings.js";
import type { PiModel } from "../src/thinking.js";

/** Wraps the real agent-file reader in a spy, so a test can count the reads. */
vi.mock("../src/agent-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof agentFileModule>();
  return { ...actual, loadAgentFile: vi.fn<typeof actual.loadAgentFile>(actual.loadAgentFile) };
});

// SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
const rawModel: unknown = {
  provider: "anthropic",
  id: "claude-opus-5",
  name: "Opus",
  reasoning: true,
};
const model = rawModel as PiModel;

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
  onEvent?: (event: SubagentEvent) => void,
) {
  return Manager.layer().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        settingsLayer(overrides),
        Intercom.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ParentDelivery,
              ParentDelivery.of({
                send: (message, mode) => sent.push({ message, mode }),
                // Short enough that a forgotten reply cannot hang the suite.
                replyTimeoutMs: 200,
              }),
            ),
          ),
        ),
        Layer.succeed(
          ManagerSurfaces,
          ManagerSurfaces.of({
            onChange: onChange ?? (() => undefined),
            onEvent: onEvent ?? (() => undefined),
          }),
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
          // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
          const rawToolEvent: unknown = {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "grep",
            args: { pattern: "useEffect" },
          };
          listener(rawToolEvent as AgentSessionEvent);
          // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
          const rawMessageEnd: unknown = {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              usage: {
                input: 90,
                output: 10,
                cacheWrite: 0,
                cacheRead: 5_000,
                cost: { total: 0.002 },
              },
            },
          };
          listener(rawMessageEnd as AgentSessionEvent);
        }
        const text = await answer(task, options);
        // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
        const rawMessage: unknown = {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        };
        messages.push(rawMessage as AgentSession["messages"][number]);
      },
      steer: async () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    };
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const rawSession: unknown = session;
    return {
      session: rawSession as Awaited<ReturnType<ChildFactory>>["session"],
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
    projectTrusted: true,
    create,
    ...overrides,
  };
}

/** Runs one program against a fresh manager and tears the layer down after. */
function withManager<A, E>(
  sent: Sent[],
  // start reads Settings from the manager's context, so a program may carry
  // that requirement; the layers below merge Settings into the environment.
  program: (manager: Manager["Service"]) => Effect.Effect<A, E, Settings>,
  overrides: Partial<SubagentSettings> = {},
  onChange?: (runs: readonly RunView[]) => void,
  onEvent?: (event: SubagentEvent) => void,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* Manager;
      return yield* program(manager);
    }).pipe(Effect.provide(layers(sent, overrides, onChange, onEvent))),
  );
}

function outputs(run: RunView): Record<string, string | undefined> {
  return Object.fromEntries(run.tasks.map((entry) => [entry.id, entry.output?.trim()]));
}

describe("Manager.start", () => {
  it("reads each distinct agent file once per start", async () => {
    const mocked = vi.mocked(loadAgentFile);
    mocked.mockClear();
    const sent: Sent[] = [];
    await withManager(sent, (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            Array.from({ length: 16 }, (_, index) =>
              task({ id: `t${index + 1}`, agent: "same agent", prompt: `prompt ${index + 1}` }),
            ),
            childFactory((prompt) => `answered ${prompt}`),
          ),
        );
        yield* manager.wait(started.id, undefined);
      }),
    );

    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("same agent", "/repo");
  });

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
    // The view reports what the child was sent, not the template it came from.
    const down = run.tasks.find((entry) => entry.id === "down")!;
    // `task` stays the short label; `prompt` is the instruction as sent.
    expect(down.task).toBe("read");
    expect(down.prompt).toBe(seen[1]);
    expect(down.prompt).toContain("use THE FACT");
  });

  it("reports no prompt for a task that never dispatched", async () => {
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

    const byId = (id: string) => run.tasks.find((entry) => entry.id === id)!;
    expect(byId("down").status).toBe("skipped");
    expect(byId("down").prompt).toBeUndefined();
    expect(byId("up").prompt).toBe("gather");
    expect(byId("up").task).toBe("read");
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

  it("keeps each run on the mode that was set when it started", async () => {
    const sent: Sent[] = [];
    /** A settings file someone edits between the two starts. */
    let value: SubagentSettings = { ...DEFAULT_SETTINGS, permissions: "read-only" };
    const mutableSettings = Layer.succeed(
      Settings,
      Settings.of({
        current: Effect.sync(() => value),
        warnings: [],
        path: "/dev/null",
        update: () => Effect.void,
      }),
    );

    /** What each child was actually handed, in spawn order. */
    const granted: string[] = [];
    const create: ChildFactory = (options) => {
      granted.push(options.permissions);
      return childFactory(() => "done")(options);
    };

    const views = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* Manager;
        const first = yield* manager.start(request([task({ id: "a" })], create));
        yield* manager.wait(first.id, undefined);

        // The flip lands between the two runs.
        value = { ...value, permissions: "read-write" };

        const second = yield* manager.start(request([task({ id: "b" })], create));
        yield* manager.wait(second.id, undefined);

        return [yield* manager.view(first.id), yield* manager.view(second.id)] as const;
      }).pipe(
        Effect.provide(
          Manager.layer().pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                mutableSettings,
                Intercom.layer.pipe(
                  Layer.provide(
                    Layer.succeed(
                      ParentDelivery,
                      ParentDelivery.of({
                        send: (message, mode) => sent.push({ message, mode }),
                        replyTimeoutMs: 200,
                      }),
                    ),
                  ),
                ),
                Layer.succeed(
                  ManagerSurfaces,
                  ManagerSurfaces.of({
                    onChange: () => undefined,
                    onEvent: () => undefined,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(granted).toEqual(["read-only", "read-write"]);
    // The earlier run is not rewritten by a later flip.
    expect(views[0].permissions).toBe("read-only");
    expect(views[1].permissions).toBe("read-write");
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
                // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
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
    if (outcome.kind !== "traffic") {
      return;
    }
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]).toMatchObject({ kind: "ask", text: "which branch?" });
  });

  it("reports which child is blocked and on what, then clears it", async () => {
    const blocked: { id: string; question: string }[] = [];
    const run = await withManager(
      [],
      (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start(
            request(
              [task({ id: "a" })],
              childFactory(async (_prompt, options) => {
                const ask = options.customTools?.find((tool) => tool.name === "ask_parent");
                await ask!.execute(
                  "call-1",
                  { question: "which branch?" },
                  undefined,
                  undefined,
                  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
                  undefined as never,
                );
                return "done";
              }),
            ),
          );
          yield* manager.wait(started.id, undefined);
          yield* manager.reply(started.id, "a", "main");
          yield* manager.wait(started.id, undefined);
          return yield* manager.view(started.id);
        }),
      {},
      (runs) => {
        for (const task_ of runs.flatMap((entry) => entry.tasks)) {
          if (task_.waiting) {
            blocked.push({ id: task_.id, question: task_.waiting.question });
          }
        }
      },
    );

    expect(blocked.map((entry) => entry.question)).toContain("which branch?");
    expect(blocked.every((entry) => entry.id === "a")).toBe(true);
    // The channel scope closes before the task settles, so nothing is stale.
    expect(run.tasks[0]?.waiting).toBeUndefined();
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
                // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
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
    if (outcome.kind !== "settled") {
      return;
    }
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

describe("accounting", () => {
  it("keeps the work total and the bill apart on the view and in the aggregate", async () => {
    const run = await withManager([], (manager) =>
      Effect.gen(function* () {
        const started = yield* manager.start(
          request(
            [task({ id: "a" }), task({ id: "b" })],
            childFactory(() => "done"),
          ),
        );
        yield* manager.wait(started.id, undefined);
        return yield* manager.view(started.id);
      }),
    );

    expect(run.tasks[0]).toMatchObject({ tokens: 100, billedTokens: 5_100, cost: 0.002 });
    expect(aggregateUsage(run.tasks)).toEqual({
      tokens: 200,
      billedTokens: 10_200,
      cost: 0.004,
    });
  });
});

describe("the event bus", () => {
  async function collect(tasks: readonly TaskRequest[]) {
    const events: SubagentEvent[] = [];
    await withManager(
      [],
      (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start(
            request(
              tasks,
              childFactory(() => "done"),
            ),
          );
          yield* manager.wait(started.id, undefined);
        }),
      {},
      undefined,
      (event) => events.push(event),
    );
    return events;
  }

  it("emits started, one settled per task, then run settled", async () => {
    const events = await collect([task({ id: "a" }), task({ id: "b" })]);

    expect(events.map((event) => event.channel)).toEqual([
      EVENT_RUN_STARTED,
      EVENT_TASK_SETTLED,
      EVENT_TASK_SETTLED,
      EVENT_RUN_SETTLED,
    ]);
  });

  it("carries ids, status and usage, and no prompts or output", async () => {
    const events = await collect([task({ id: "a" })]);

    const settled = events.find((event) => event.channel === EVENT_TASK_SETTLED)!;
    expect(settled).toMatchObject({
      runId: "run_1",
      task: { id: "a", agent: "a reader", status: "settled", outcome: "completed" },
      usage: { tokens: 100, billedTokens: 5_100, cost: 0.002 },
    });
    expect(JSON.stringify(settled)).not.toContain("read the thing");

    const finished = events.at(-1)!;
    expect(finished).toMatchObject({
      channel: EVENT_RUN_SETTLED,
      cancelled: false,
      usage: { tokens: 100 },
    });
  });

  it("keeps running when a subscriber throws", async () => {
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
      undefined,
      () => {
        throw new Error("the subscriber blew up");
      },
    );

    expect(outputs(run).a).toBe("done");
  });
});
