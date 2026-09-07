import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Context, Deferred, Effect, Layer, type Scope } from "effect";
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

export interface TaskChannelOptions {
  readonly onWaitingChange?: (waiting: boolean) => void;
}

export interface TaskChannel {
  ask(question: string): Effect.Effect<string>;
  notify(message: string, level: NotificationLevel): Effect.Effect<void>;
}

export interface ParkedWaiter {
  readonly wait: Effect.Effect<readonly ParentTraffic[]>;
}

export interface ParentDelivery {
  send(message: string, mode: ParentDeliveryMode): void;
}

interface PendingAsk {
  readonly channel: TaskChannelState;
  readonly reply: Deferred.Deferred<string>;
}

interface TaskChannelState {
  readonly address: TaskAddress;
  readonly onWaitingChange: ((waiting: boolean) => void) | undefined;
  closed: boolean;
}

interface ParkedState {
  readonly messages: ParentTraffic[];
  readonly wake: Deferred.Deferred<void>;
}

interface IntercomState {
  readonly channels: Map<string, TaskChannelState>;
  readonly pending: Map<string, PendingAsk>;
  readonly parked: Map<string, Set<ParkedState>>;
}

type ParkedDelivery = {
  readonly parked: boolean;
  readonly wakes: readonly Deferred.Deferred<void>[];
};

function addressKey(address: Pick<TaskAddress, "runId" | "taskId">): string {
  return `${address.runId}:${address.taskId}`;
}

function safelyNotify(state: TaskChannelState, waiting: boolean): void {
  try {
    state.onWaitingChange?.(waiting);
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

function collectParked(state: IntercomState, traffic: ParentTraffic): ParkedDelivery {
  const parked = state.parked.get(traffic.address.runId);
  if (!parked || parked.size === 0) {
    return { parked: false, wakes: [] };
  }

  const wakes: Deferred.Deferred<void>[] = [];
  for (const waiter of parked) {
    if (waiter.messages.length < PARKED_MESSAGE_CAP) {
      waiter.messages.push(traffic);
      wakes.push(waiter.wake);
      continue;
    }
    if (traffic.kind !== "ask") {
      continue;
    }

    const drop = waiter.messages.findIndex((message) => message.kind !== "ask");
    // A valid run has at most 16 outstanding asks, below the cap, so a queue of
    // nothing but asks cannot happen. If it ever does, overwrite the newest
    // rather than drop the question that arrived.
    if (drop === -1) {
      waiter.messages[waiter.messages.length - 1] = traffic;
    } else {
      waiter.messages.splice(drop, 1);
      waiter.messages.push(traffic);
    }
    wakes.push(waiter.wake);
  }
  return { parked: true, wakes };
}

function completeAll<A>(deferreds: readonly Deferred.Deferred<A>[], value: A): Effect.Effect<void> {
  return Effect.forEach(deferreds, (deferred) => Deferred.succeed(deferred, value), {
    concurrency: "unbounded",
    discard: true,
  });
}

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
  static layer(delivery: ParentDelivery, replyTimeoutMs = PARENT_REPLY_TIMEOUT_MS) {
    return Layer.effect(
      Intercom,
      Effect.acquireRelease(
        Effect.sync((): IntercomState => ({
          channels: new Map(),
          pending: new Map(),
          parked: new Map(),
        })),
        (state) =>
          Effect.gen(function* () {
            const replies = [...state.pending.values()].map((pending) => pending.reply);
            const wakes = [...state.parked.values()].flatMap((waiters) =>
              [...waiters].map((waiter) => waiter.wake),
            );
            for (const channel of state.channels.values()) {
              channel.closed = true;
            }
            for (const pending of state.pending.values()) {
              safelyNotify(pending.channel, false);
            }
            state.channels.clear();
            state.pending.clear();
            state.parked.clear();
            yield* completeAll(replies, TASK_ENDED_REPLY);
            yield* completeAll(wakes, undefined);
          }),
      ).pipe(
        Effect.map((state) => {
          const publish = Effect.fn("Intercom.publish")(function* (
            traffic: ParentTraffic,
            mode: ParentDeliveryMode = "followUp",
            directText = formatTraffic(traffic),
          ) {
            const parked = yield* Effect.sync(() => collectParked(state, traffic));
            yield* completeAll(parked.wakes, undefined);
            if (parked.parked) {
              return;
            }
            yield* Effect.try({
              try: () => delivery.send(directText, mode),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.void));
          });

          const openTask = Effect.fn("Intercom.openTask")(function* (
            address: TaskAddress,
            options: TaskChannelOptions = {},
          ) {
            const key = addressKey(address);
            const channel = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const opened: TaskChannelState = {
                  address,
                  onWaitingChange: options.onWaitingChange,
                  closed: false,
                };
                state.channels.set(key, opened);
                return opened;
              }),
              (opened) =>
                Effect.gen(function* () {
                  const pending = yield* Effect.sync(() => {
                    opened.closed = true;
                    if (state.channels.get(key) === opened) {
                      state.channels.delete(key);
                    }
                    const current = state.pending.get(key);
                    if (current?.channel !== opened) {
                      return undefined;
                    }
                    state.pending.delete(key);
                    safelyNotify(opened, false);
                    return current.reply;
                  });
                  if (pending) {
                    yield* Deferred.succeed(pending, TASK_ENDED_REPLY);
                  }
                }),
            );

            const ask = Effect.fn("Intercom.ask")(function* (question: string) {
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const reply = yield* Deferred.make<string>();
                  const registration = yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      if (channel.closed) {
                        return "closed" as const;
                      }
                      if (state.pending.has(key)) {
                        return "duplicate" as const;
                      }
                      const pending: PendingAsk = { channel, reply };
                      state.pending.set(key, pending);
                      safelyNotify(channel, true);
                      return "registered" as const;
                    }),
                    (registered) =>
                      Effect.sync(() => {
                        if (registered !== "registered") {
                          return;
                        }
                        const current = state.pending.get(key);
                        if (current?.reply === reply) {
                          state.pending.delete(key);
                        }
                        if (!channel.closed) {
                          safelyNotify(channel, false);
                        }
                      }),
                  );

                  if (registration === "closed") {
                    return TASK_ENDED_REPLY;
                  }
                  if (registration === "duplicate") {
                    return DUPLICATE_ASK_REPLY;
                  }

                  yield* publish({ kind: "ask", address, text: question });
                  const answer = yield* Deferred.await(reply).pipe(
                    Effect.timeoutOrElse({
                      duration: replyTimeoutMs,
                      orElse: () => Effect.succeed(PARENT_REPLY_TIMEOUT),
                    }),
                  );
                  return channel.closed ? TASK_ENDED_REPLY : answer;
                }),
              );
            });

            const notify = Effect.fn("Intercom.notify")(function* (
              message: string,
              level: NotificationLevel,
            ) {
              if (channel.closed) {
                return;
              }
              yield* publish({ kind: "notify", address, text: message, level });
            });

            return { ask, notify } satisfies TaskChannel;
          });

          const park = Effect.fn("Intercom.park")(function* (runId: string) {
            const waiter = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const wake = yield* Deferred.make<void>();
                return yield* Effect.sync(() => {
                  const opened: ParkedState = { messages: [], wake };
                  const waiters = state.parked.get(runId) ?? new Set<ParkedState>();
                  waiters.add(opened);
                  state.parked.set(runId, waiters);
                  return opened;
                });
              }),
              (opened) =>
                Effect.sync(() => {
                  const waiters = state.parked.get(runId);
                  waiters?.delete(opened);
                  if (waiters?.size === 0) {
                    state.parked.delete(runId);
                  }
                }),
            );
            return {
              wait: Deferred.await(waiter.wake).pipe(
                Effect.andThen(Effect.sync(() => [...waiter.messages])),
              ),
            } satisfies ParkedWaiter;
          });

          const reply = Effect.fn("Intercom.reply")(function* (
            runId: string,
            taskId: string,
            message: string,
          ) {
            const pending = yield* Effect.sync(() => {
              const key = addressKey({ runId, taskId });
              const current = state.pending.get(key);
              if (!current || current.channel.closed) {
                return undefined;
              }
              state.pending.delete(key);
              return current.reply;
            });
            if (!pending) {
              return "not_waiting" as const;
            }
            yield* Deferred.succeed(pending, message);
            return "delivered" as const;
          });

          const finishRun = Effect.fn("Intercom.finishRun")(function* (runId: string) {
            const wakes = yield* Effect.sync(() => {
              const waiters = state.parked.get(runId);
              state.parked.delete(runId);
              return waiters ? [...waiters].map((waiter) => waiter.wake) : [];
            });
            yield* completeAll(wakes, undefined);
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
            yield* publish(
              traffic,
              startupFailure ? "steer" : "followUp",
              startupFailure ? formatStartupFailure(address, result) : formatTraffic(traffic),
            );
          });

          return Intercom.of({ openTask, park, reply, finishRun, settle });
        }),
      ),
    );
  }
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
