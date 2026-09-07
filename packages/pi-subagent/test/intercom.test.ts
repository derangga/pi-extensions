import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, type Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createIntercomTools,
  DUPLICATE_ASK_REPLY,
  Intercom,
  PARKED_MESSAGE_CAP,
  PARENT_REPLY_TIMEOUT,
  TASK_ENDED_REPLY,
  type ParentDeliveryMode,
  type ParentTraffic,
  type TaskAddress,
  type TaskChannel,
} from "../src/intercom.js";
import type { ChildRunResult } from "../src/lifecycle.js";

interface Delivery {
  readonly message: string;
  readonly mode: ParentDeliveryMode;
}

const address: TaskAddress = { runId: "run-1", taskId: "research", task: "Research" };

function runIntercom<A>(
  body: Effect.Effect<A, never, Intercom | Scope.Scope>,
  deliveries: Delivery[] = [],
  replyTimeoutMs = 100,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(
        Intercom.layer(
          { send: (message, mode) => deliveries.push({ message, mode }) },
          replyTimeoutMs,
        ),
      ),
    ),
  );
}

function result(overrides: Partial<ChildRunResult> = {}): ChildRunResult {
  return {
    outcome: "completed",
    output: "answer",
    producedOutput: true,
    partial: false,
    turns: 1,
    sessionFile: "/tmp/child.jsonl",
    notes: [],
    ...overrides,
  };
}

describe("Intercom", () => {
  it("makes an ask replyable before invoking parent delivery", async () => {
    let service: Intercom["Service"] | undefined;
    let reply: Promise<"delivered" | "not_waiting"> | undefined;
    const layer = Intercom.layer(
      {
        send: () => {
          if (service) {
            reply = Effect.runPromise(service.reply(address.runId, address.taskId, "immediate"));
          }
        },
      },
      5,
    );

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          service = yield* Intercom;
          const channel = yield* service.openTask(address);
          return yield* channel.ask("Can you answer now?");
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(answer).toBe("immediate");
    await expect(reply).resolves.toBe("delivered");
  });

  it("registers an ask before delivery and consumes one parent reply", async () => {
    const deliveries: Delivery[] = [];
    const observed = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const channel = yield* intercom.openTask(address);
        const answer = yield* channel.ask("Which branch?").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const first = yield* intercom.reply(address.runId, address.taskId, "main");
        const second = yield* intercom.reply(address.runId, address.taskId, "other");
        return { answer: yield* Fiber.join(answer), first, second };
      }),
      deliveries,
    );

    expect(observed).toEqual({ answer: "main", first: "delivered", second: "not_waiting" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ mode: "followUp" });
    expect(deliveries[0]!.message).toContain('task "research"');
  });

  it("permits only one outstanding ask per task", async () => {
    const observed = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const channel = yield* intercom.openTask(address);
        const first = yield* channel.ask("First?").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const duplicate = yield* channel.ask("Second?");
        yield* intercom.reply(address.runId, address.taskId, "answer");
        return { duplicate, first: yield* Fiber.join(first) };
      }),
    );

    expect(observed).toEqual({ duplicate: DUPLICATE_ASK_REPLY, first: "answer" });
  });

  it("times out with best-judgment guidance and rejects a late reply", async () => {
    const observed = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const channel = yield* intercom.openTask(address);
        const answer = yield* channel.ask("Anyone there?");
        const late = yield* intercom.reply(address.runId, address.taskId, "too late");
        return { answer, late };
      }),
      [],
      1,
    );

    expect(observed).toEqual({ answer: PARENT_REPLY_TIMEOUT, late: "not_waiting" });
  });

  it("resolves an outstanding ask when the task scope closes", async () => {
    const answer = await runIntercom(
      Effect.gen(function* () {
        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const intercom = yield* Intercom;
            const channel = yield* intercom.openTask(address);
            const pending = yield* channel.ask("Still running?").pipe(Effect.forkDetach);
            yield* Effect.yieldNow;
            return pending;
          }),
        );
        return yield* Fiber.join(fiber);
      }),
    );

    expect(answer).toBe(TASK_ENDED_REPLY);
  });

  it("parks traffic instead of delivering directly", async () => {
    const deliveries: Delivery[] = [];
    const traffic = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const waiter = yield* intercom.park(address.runId);
        const channel = yield* intercom.openTask(address);
        yield* channel.notify("found it", "info");
        return yield* waiter.wait;
      }),
      deliveries,
    );

    expect(traffic).toEqual([
      { kind: "notify", address, text: "found it", level: "info" } satisfies ParentTraffic,
    ]);
    expect(deliveries).toEqual([]);
  });

  it("gives simultaneous parked waiters independent traffic copies", async () => {
    const observed = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const first = yield* intercom.park(address.runId);
        const second = yield* intercom.park(address.runId);
        const channel = yield* intercom.openTask(address);
        yield* channel.notify("shared", "warning");
        return yield* Effect.all([first.wait, second.wait]);
      }),
    );

    expect(observed[0]).toEqual(observed[1]);
    expect(observed[0]).toHaveLength(1);
  });

  it("drops excess notifications but lets an ask displace the oldest one", async () => {
    const traffic = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const waiter = yield* intercom.park(address.runId);
        const channel = yield* intercom.openTask(address);
        for (let index = 0; index <= PARKED_MESSAGE_CAP; index++) {
          yield* channel.notify(`note-${index}`, "info");
        }
        const pending = yield* channel.ask("Important?").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* intercom.reply(address.runId, address.taskId, "yes");
        yield* Fiber.join(pending);
        return yield* waiter.wait;
      }),
    );

    expect(traffic).toHaveLength(PARKED_MESSAGE_CAP);
    expect(traffic.some((message) => message.kind === "ask")).toBe(true);
    expect(traffic.some((message) => message.text === "note-0")).toBe(false);
    expect(traffic.some((message) => message.text === `note-${PARKED_MESSAGE_CAP}`)).toBe(false);
  });

  it("wakes a parked waiter when its run finishes without traffic", async () => {
    const traffic = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const waiter = yield* intercom.park(address.runId);
        yield* intercom.finishRun(address.runId);
        return yield* waiter.wait;
      }),
    );

    expect(traffic).toEqual([]);
  });

  it("steers startup failures and follows up for ordinary settlements", async () => {
    const deliveries: Delivery[] = [];
    await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        yield* intercom.settle(
          address,
          result({
            outcome: "failed",
            output: "[Status: Failed: missing key; output is partial.]",
            producedOutput: false,
            error: "missing key",
            partial: true,
            turns: 0,
            sessionFile: undefined,
          }),
        );
        yield* intercom.settle(address, result());
        yield* intercom.settle(
          address,
          result({
            outcome: "failed",
            output: "Partial output before termination:\nuseful work",
            producedOutput: true,
            error: "request failed",
            partial: true,
          }),
        );
      }),
      deliveries,
    );

    expect(deliveries.map(({ mode }) => mode)).toEqual(["steer", "followUp", "followUp"]);
    expect(deliveries[0]!.message).toContain("Stop and diagnose");
  });

  it("reports waiting transitions without allowing observer failures to strand asks", async () => {
    const transitions: boolean[] = [];
    const answer = await runIntercom(
      Effect.gen(function* () {
        const intercom = yield* Intercom;
        const channel = yield* intercom.openTask(address, {
          onWaitingChange: (waiting) => {
            transitions.push(waiting);
            if (waiting) throw new Error("broken observer");
          },
        });
        const pending = yield* channel.ask("Continue?").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* intercom.reply(address.runId, address.taskId, "yes");
        return yield* Fiber.join(pending);
      }),
    );

    expect(answer).toBe("yes");
    expect(transitions).toEqual([true, false]);
  });
});

describe("intercom child tools", () => {
  type Execute = (
    id: string,
    params: unknown,
  ) => Promise<{
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  }>;

  function execute(tool: ToolDefinition): Execute {
    const executable = tool as unknown as { execute: Execute };
    return (id, params) => executable.execute(id, params);
  }

  it("waits for asks and returns immediately from notifications", async () => {
    const ask = vi.fn<(question: string) => Effect.Effect<string>>(() => Effect.succeed("reply"));
    const notify = vi.fn<
      (message: string, level: "info" | "warning" | "error") => Effect.Effect<void>
    >(() => Effect.void);
    const tools = createIntercomTools({ ask, notify } satisfies TaskChannel);

    const askResult = await execute(tools.find((tool) => tool.name === "ask_parent")!)("ask", {
      question: "Question?",
    });
    const notifyResult = await execute(tools.find((tool) => tool.name === "notify_parent")!)(
      "notify",
      { message: "Update" },
    );

    expect(ask).toHaveBeenCalledWith("Question?");
    expect(askResult.content[0]?.text).toBe("reply");
    expect(notify).toHaveBeenCalledWith("Update", "info");
    expect(notifyResult.content[0]?.text).toBe("Sent.");
  });
});
