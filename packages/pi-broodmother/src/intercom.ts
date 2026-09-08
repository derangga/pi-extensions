import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Clock, Context, Deferred, Effect, Layer, Queue, type Cause, type Scope } from "effect";
import { Type } from "typebox";

import type { ChildRunResult } from "./lifecycle.js";

export const PARENT_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
export const PARKED_MESSAGE_CAP = 24;

export const PARENT_REPLY_TIMEOUT =
  "The parent did not answer in time. Proceed autonomously with your best judgment and state the assumption you made in your final answer.";
export const TASK_ENDED_REPLY =
  "Your task ended while you waited. Stop work and return immediately.";
export const DUPLICATE_ASK_REPLY =
  "You already have a question awaiting the parent. Continue waiting for that answer.";

export type NotificationLevel = "info" | "warning" | "error";
export type ParentDeliveryMode = "steer" | "followUp";

export interface TaskAddress {
  readonly runId: string;
  readonly taskId: string;
  readonly task: string;
}

export type ParentTraffic =
  | {
      readonly kind: "ask";
      readonly address: TaskAddress;
      readonly text: string;
    }
  | {
      readonly kind: "notify";
      readonly address: TaskAddress;
      readonly text: string;
      readonly level: NotificationLevel;
    }
  | {
      readonly kind: "settled";
      readonly address: TaskAddress;
      readonly text: string;
      readonly outcome: ChildRunResult["outcome"];
    };

export type ReplyOutcome = "delivered" | "not_waiting";

/**
 * The question a child is stuck on, for a surface to show. Read-only: whoever
 * renders this never consumes the ask, which stays the parked waiter's to drain.
 */
export interface AskWaiting {
  readonly question: string;
  /** When the child started waiting, against PARENT_REPLY_TIMEOUT_MS. */
  readonly since: number;
}

export interface TaskChannelOptions {
  readonly onWaitingChange?: (ask: AskWaiting | undefined) => void;
}

export interface TaskChannel {
  ask(question: string): Effect.Effect<string>;
  notify(message: string, level: NotificationLevel): Effect.Effect<void>;
}

export interface ParkedWaiter {
  readonly wait: Effect.Effect<readonly ParentTraffic[]>;
}

/**
 * The parent side of the channel, injected by the runtime that hosts the
 * extension. A bare key is the right shape here: Pi hands over the send
 * callback, nothing constructs it, and every embedding provides its own.
 */
export class ParentDelivery extends Context.Service<
  ParentDelivery,
  {
    /** Push a message into the parent's conversation. */
    readonly send: (message: string, mode: ParentDeliveryMode) => void;
    /** How long a child waits for an answer before proceeding without one. */
    readonly replyTimeoutMs: number;
  }
>()("pi-broodmother/ParentDelivery") {}

/** One open task channel, and the one question it may have outstanding. */
interface AskSlot {
  readonly address: TaskAddress;
  readonly onWaitingChange: ((ask: AskWaiting | undefined) => void) | undefined;
  closed: boolean;
  pending: Deferred.Deferred<string> | undefined;
}

/**
 * What a claim on a slot's single ask seat produced: the latch to await, or the
 * reason there is nothing to wait for.
 */
type AskClaim = Deferred.Deferred<string> | "closed" | "duplicate";

/**
 * A parked reader's buffer. Sliding, so the newest traffic always gets a seat
 * and a child's question can never be refused admission behind stale notices.
 */
type ParkedQueue = Queue.Queue<ParentTraffic, Cause.Done>;

function addressKey(address: Pick<TaskAddress, "runId" | "taskId">): string {
  return `${address.runId}:${address.taskId}`;
}

function safelyNotify(slot: AskSlot, ask: AskWaiting | undefined): void {
  try {
    slot.onWaitingChange?.(ask);
  } catch {
    // UI/status observers cannot be allowed to strand the child on its latch.
  }
}

function formatTraffic(traffic: ParentTraffic): string {
  const { address } = traffic;
  const heading = `Subagent ${address.task} (${address.taskId}, run ${address.runId})`;
  switch (traffic.kind) {
    case "ask":
      return `[${heading} asks]\n${traffic.text}\n\nReply with reply_subagent for run "${address.runId}" and task "${address.taskId}".`;
    case "notify":
      return `[${heading}, ${traffic.level}]\n${traffic.text}`;
    case "settled":
      return `[${heading} ${traffic.outcome}]\n${traffic.text}`;
  }
}

function formatStartupFailure(address: TaskAddress, result: ChildRunResult): string {
  return `[Subagent ${address.task} (${address.taskId}, run ${address.runId}) failed before producing output]\n${result.error ?? result.output}\n\nThis failure will recur if the task is respawned with the same configuration. Stop and diagnose it instead of retrying blindly.`;
}

function completeAll<A>(deferreds: readonly Deferred.Deferred<A>[], value: A): Effect.Effect<void> {
  return Effect.forEach(deferreds, (deferred) => Deferred.succeed(deferred, value), {
    concurrency: "unbounded",
    discard: true,
  });
}

/**
 * The task side of the intercom: who is open, and who is holding a question.
 * Knows nothing about how a question reaches the parent.
 */
const makeAskBook = Effect.fnUntraced(function* () {
  const slots = new Map<string, AskSlot>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const replies: Deferred.Deferred<string>[] = [];
      for (const slot of slots.values()) {
        slot.closed = true;
        if (slot.pending) {
          replies.push(slot.pending);
          slot.pending = undefined;
          safelyNotify(slot, undefined);
        }
      }
      slots.clear();
      return replies;
    }).pipe(Effect.flatMap((replies) => completeAll(replies, TASK_ENDED_REPLY))),
  );

  const open = Effect.fnUntraced(function* (address: TaskAddress, options: TaskChannelOptions) {
    const key = addressKey(address);
    return yield* Effect.acquireRelease(
      Effect.sync((): AskSlot => {
        const slot: AskSlot = {
          address,
          onWaitingChange: options.onWaitingChange,
          closed: false,
          pending: undefined,
        };
        slots.set(key, slot);
        return slot;
      }),
      (slot) =>
        Effect.sync(() => {
          slot.closed = true;
          if (slots.get(key) === slot) {
            slots.delete(key);
          }
          const pending = slot.pending;
          slot.pending = undefined;
          if (pending) {
            safelyNotify(slot, undefined);
          }
          return pending;
        }).pipe(
          Effect.flatMap((pending) =>
            pending ? Deferred.succeed(pending, TASK_ENDED_REPLY) : Effect.void,
          ),
        ),
    );
  });

  const claim = Effect.fnUntraced(function* (slot: AskSlot, question: string) {
    const reply = yield* Deferred.make<string>();
    // The waiting readout measures from this stamp, so it comes from the Clock
    // like every other timestamp the package records: under a test clock it is
    // virtual time, and a direct Date.now here would disagree with all of them.
    const since = yield* Clock.currentTimeMillis;
    return yield* Effect.acquireRelease(
      Effect.sync((): AskClaim => {
        if (slot.closed) {
          return "closed";
        }
        if (slot.pending) {
          return "duplicate";
        }
        slot.pending = reply;
        safelyNotify(slot, { question, since });
        return reply;
      }),
      (claimed) =>
        Effect.sync(() => {
          if (claimed !== reply) {
            return;
          }
          if (slot.pending === reply) {
            slot.pending = undefined;
          }
          if (!slot.closed) {
            safelyNotify(slot, undefined);
          }
        }),
    );
  });

  const answer = Effect.fn("Intercom.reply")(function* (
    runId: string,
    taskId: string,
    message: string,
  ): Effect.fn.Return<ReplyOutcome> {
    const pending = yield* Effect.sync(() => {
      const slot = slots.get(addressKey({ runId, taskId }));
      if (!slot || slot.closed || !slot.pending) {
        return undefined;
      }
      const reply = slot.pending;
      slot.pending = undefined;
      return reply;
    });
    if (!pending) {
      return "not_waiting";
    }
    yield* Deferred.succeed(pending, message);
    return "delivered";
  });

  return { open, claim, answer };
});

/**
 * The parent side: traffic goes to whoever is parked on the run, and only
 * reaches the parent's conversation when nobody is.
 */
const makeTrafficBus = Effect.fnUntraced(function* (delivery: ParentDelivery["Service"]) {
  const parked = new Map<string, Set<ParkedQueue>>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const queues of parked.values()) {
        for (const queue of queues) {
          Queue.endUnsafe(queue);
        }
      }
      parked.clear();
    }),
  );

  const publish = Effect.fn("Intercom.publish")(function* (
    traffic: ParentTraffic,
    mode: ParentDeliveryMode = "followUp",
    directText = formatTraffic(traffic),
  ) {
    const handed = yield* Effect.sync(() => {
      const queues = parked.get(traffic.address.runId);
      if (!queues || queues.size === 0) {
        return false;
      }
      for (const queue of queues) {
        Queue.offerUnsafe(queue, traffic);
      }
      return true;
    });
    if (handed) {
      return;
    }
    yield* Effect.try(() => delivery.send(directText, mode)).pipe(Effect.ignore);
  });

  const park = Effect.fn("Intercom.park")(function* (runId: string) {
    const queue = yield* Queue.make<ParentTraffic, Cause.Done>({
      capacity: PARKED_MESSAGE_CAP,
      strategy: "sliding",
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const queues = parked.get(runId) ?? new Set<ParkedQueue>();
        queues.add(queue);
        parked.set(runId, queues);
      }),
      () =>
        Effect.sync(() => {
          const queues = parked.get(runId);
          queues?.delete(queue);
          if (queues?.size === 0) {
            parked.delete(runId);
          }
        }),
    );
    return {
      // Blocks for the first message, then drains whatever else has landed. A
      // finished run ends the queue instead of feeding it, which reads as the
      // empty batch the caller treats as "nothing left to wait for".
      wait: Queue.takeAll(queue).pipe(
        Effect.catch((): Effect.Effect<readonly ParentTraffic[]> => Effect.succeed([])),
      ),
    } satisfies ParkedWaiter;
  });

  const finish = Effect.fn("Intercom.finishRun")(function* (runId: string) {
    yield* Effect.sync(() => {
      const queues = parked.get(runId);
      parked.delete(runId);
      for (const queue of queues ?? []) {
        Queue.endUnsafe(queue);
      }
    });
  });

  return { publish, park, finish };
});

export class Intercom extends Context.Service<
  Intercom,
  {
    openTask(
      address: TaskAddress,
      options?: TaskChannelOptions,
    ): Effect.Effect<TaskChannel, never, Scope.Scope>;
    park(runId: string): Effect.Effect<ParkedWaiter, never, Scope.Scope>;
    reply(runId: string, taskId: string, message: string): Effect.Effect<ReplyOutcome>;
    finishRun(runId: string): Effect.Effect<void>;
    settle(address: TaskAddress, result: ChildRunResult): Effect.Effect<void>;
  }
>()("pi-broodmother/Intercom") {
  static readonly layer = Layer.effect(
    Intercom,
    Effect.gen(function* () {
      const delivery = yield* ParentDelivery;
      // Bus first, so on teardown the book's finalizer answers every waiting
      // child before the bus tears down the queues those answers travel on.
      const bus = yield* makeTrafficBus(delivery);
      const book = yield* makeAskBook();

      const openTask = Effect.fn("Intercom.openTask")(function* (
        address: TaskAddress,
        options: TaskChannelOptions = {},
      ) {
        const slot = yield* book.open(address, options);

        const ask = Effect.fn("Intercom.ask")(function* (question: string) {
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const claim = yield* book.claim(slot, question);
              if (claim === "closed") {
                return TASK_ENDED_REPLY;
              }
              if (claim === "duplicate") {
                return DUPLICATE_ASK_REPLY;
              }

              // Claimed before published: a parent that answers inside `send`
              // finds a seat to answer into.
              yield* bus.publish({ kind: "ask", address, text: question });
              const answer = yield* Deferred.await(claim).pipe(
                Effect.timeoutOrElse({
                  duration: delivery.replyTimeoutMs,
                  orElse: () => Effect.succeed(PARENT_REPLY_TIMEOUT),
                }),
              );
              return slot.closed ? TASK_ENDED_REPLY : answer;
            }),
          );
        });

        const notify = Effect.fn("Intercom.notify")(function* (
          message: string,
          level: NotificationLevel,
        ) {
          if (slot.closed) {
            return;
          }
          yield* bus.publish({ kind: "notify", address, text: message, level });
        });

        return { ask, notify } satisfies TaskChannel;
      });

      const settle = Effect.fn("Intercom.settle")(function* (
        address: TaskAddress,
        result: ChildRunResult,
      ) {
        const traffic: ParentTraffic = {
          kind: "settled",
          address,
          text: result.output,
          outcome: result.outcome,
        };
        const startupFailure = result.outcome === "failed" && !result.producedOutput;
        yield* bus.publish(
          traffic,
          startupFailure ? "steer" : "followUp",
          startupFailure ? formatStartupFailure(address, result) : formatTraffic(traffic),
        );
      });

      return Intercom.of({
        openTask,
        park: bus.park,
        reply: book.answer,
        finishRun: bus.finish,
        settle,
      });
    }),
  );
}

export type RunEffect = <A>(effect: Effect.Effect<A>) => Promise<A>;

export function createIntercomTools(
  channel: TaskChannel,
  runEffect: RunEffect = Effect.runPromise,
): ToolDefinition[] {
  return [
    {
      name: "ask_parent",
      label: "Ask Parent",
      description:
        "Ask the parent agent one focused question and block for its reply. If no reply arrives within ten minutes, continue with your best judgment and state the assumption in your final answer.",
      promptSnippet: "Ask the parent only when information unavailable to you blocks the task.",
      promptGuidelines: [
        "Use ask_parent only when truly blocked on information only the parent has.",
        "Ask one focused question at a time. Do not wait for a task in a later dependency wave.",
      ],
      parameters: Type.Object(
        { question: Type.String({ description: "One focused question for the parent" }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
        const { question } = params as { question: string };
        const answer = await runEffect(channel.ask(question));
        return {
          content: [{ type: "text" as const, text: answer || "(parent gave no answer)" }],
          details: {},
        };
      },
    },
    {
      name: "notify_parent",
      label: "Notify Parent",
      description:
        "Send a non-blocking finding, risk, or status update to the parent. Your task continues immediately.",
      promptSnippet: "Send the parent a non-blocking update.",
      parameters: Type.Object(
        {
          message: Type.String({ description: "The update for the parent" }),
          level: Type.Optional(
            Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")], {
              default: "info",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
        const { message, level } = params as {
          message: string;
          level?: NotificationLevel;
        };
        await runEffect(channel.notify(message, level ?? "info"));
        return { content: [{ type: "text" as const, text: "Sent." }], details: {} };
      },
    },
  ];
}
