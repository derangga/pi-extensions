import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import {
  createChildSession,
  type ChildSessionOptions,
  type CreatedChildSession,
  shutdownChildSession,
} from "./child.js";

export const GRACE_TURNS = 5;
export const WALL_CLOCK_LIMIT_MS = 30 * 60 * 1000;
export const RESULT_CAP_BYTES = 24 * 1024;

const WRAP_UP =
  "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

export type ChildOutcome =
  | "completed"
  | "wrapped_up"
  | "aborted"
  | "timed_out"
  | "stopped"
  | "failed";

export interface ChildRunResult {
  readonly outcome: ChildOutcome;
  readonly output: string;
  readonly error?: string;
  readonly partial: boolean;
  readonly turns: number;
  readonly sessionFile: string | undefined;
  readonly notes: readonly string[];
}

type LifecycleSession = Pick<
  AgentSession,
  | "abort"
  | "dispose"
  | "extensionRunner"
  | "messages"
  | "prompt"
  | "sessionFile"
  | "steer"
  | "subscribe"
>;

interface LifecycleChild extends Omit<CreatedChildSession, "session"> {
  readonly session: LifecycleSession;
}

type ChildFactory = (options: ChildSessionOptions) => Promise<LifecycleChild>;

export interface ChildRunOptions {
  readonly child: ChildSessionOptions;
  readonly task: string;
  readonly maxTurns: number;
  readonly graceTurns?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly create?: ChildFactory;
}

class PromptFailed extends Schema.TaggedError<PromptFailed>()("PromptFailed", {
  message: Schema.String,
}) {}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assistantText(message: AgentSession["messages"][number]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function lastAssistant(
  messages: AgentSession["messages"],
  start: number,
): Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= start; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function truncateResult(
  text: string,
  sessionFile: string | undefined,
  maxBytes = RESULT_CAP_BYTES,
  status = "",
): string {
  const full = `${text}${status}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;

  const footer = `\n\n[Output truncated. Full transcript: ${sessionFile ?? "child session unavailable"}]`;
  const suffix = `${status}${footer}`;
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  if (budget <= 0) return sliceUtf8(suffix, maxBytes);
  return `${sliceUtf8(text, budget)}${suffix}`;
}

function statusFor(outcome: ChildOutcome, error: string | undefined): string {
  switch (outcome) {
    case "completed":
      return "";
    case "wrapped_up":
      return "\n\n[Status: Wrapped up at the turn limit; output may be partial.]";
    case "aborted":
      return "\n\n[Status: Aborted after the turn limit and grace period; output is partial.]";
    case "timed_out":
      return "\n\n[Status: Timed out before completion; output is partial.]";
    case "stopped":
      return "\n\n[Status: Stopped by the user before completion; output is partial.]";
    case "failed":
      return `\n\n[Status: Failed${error ? `: ${error}` : ""}; output is partial.]`;
  }
}

function startFailure(error: string): ChildRunResult {
  const status = statusFor("failed", error);
  return {
    outcome: "failed",
    output: status.trimStart(),
    error,
    partial: true,
    turns: 0,
    sessionFile: undefined,
    notes: [],
  };
}

const runAcquiredChild = Effect.fn("Lifecycle.runAcquired")(function* (
  child: LifecycleChild,
  options: ChildRunOptions,
) {
  const session = child.session;
  const start = session.messages.length;
  const maxTurns = Math.max(1, Math.trunc(options.maxTurns));
  const graceTurns = Math.max(1, Math.trunc(options.graceTurns ?? GRACE_TURNS));
  let turns = 0;
  let wrapRequested = false;
  let abortedAfterGrace = false;
  let stoppedByUser = options.signal?.aborted === true;
  let streamed = "";

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") streamed = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamed += event.assistantMessageEvent.delta;
    }
    if (event.type !== "turn_end") return;

    turns++;
    if (!wrapRequested && turns >= maxTurns) {
      wrapRequested = true;
      void session.steer(WRAP_UP).catch(() => undefined);
      return;
    }
    if (wrapRequested && !abortedAfterGrace && turns >= maxTurns + graceTurns) {
      abortedAfterGrace = true;
      void session.abort().catch(() => undefined);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const waitForStop: Effect.Effect<"stopped"> = options.signal
    ? Effect.callback<"stopped">((resume) => {
        const stop = () => {
          stoppedByUser = true;
          void session.abort().catch(() => undefined);
          resume(Effect.succeed("stopped"));
        };
        if (options.signal!.aborted) stop();
        else options.signal!.addEventListener("abort", stop, { once: true });
        return Effect.sync(() => options.signal!.removeEventListener("abort", stop));
      })
    : Effect.never;

  const prompt = Effect.tryPromise({
    try: () => session.prompt(options.task, { source: "extension" }),
    catch: (cause) => new PromptFailed({ message: messageFor(cause) }),
  }).pipe(
    Effect.as("settled" as const),
    Effect.onInterrupt(() =>
      Effect.promise(() => session.abort()).pipe(Effect.catch(() => Effect.void)),
    ),
  );

  const terminal = yield* Effect.raceFirst(prompt, waitForStop).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? WALL_CLOCK_LIMIT_MS,
      orElse: () => Effect.succeed("timed_out" as const),
    }),
    Effect.match({
      onFailure: (failure) => ({ kind: "failed" as const, error: failure.message }),
      onSuccess: (kind) => ({ kind }),
    }),
  );

  const final = lastAssistant(session.messages, start);
  const finalText = final ? assistantText(final) : "";
  const raw = finalText || streamed.trim();

  let outcome: ChildOutcome;
  let error: string | undefined;
  if (terminal.kind === "timed_out") {
    outcome = "timed_out";
  } else if (stoppedByUser || terminal.kind === "stopped") {
    outcome = "stopped";
  } else if (abortedAfterGrace) {
    outcome = "aborted";
  } else if (terminal.kind === "failed") {
    outcome = "failed";
    error = terminal.error;
  } else if (final?.stopReason === "error") {
    outcome = "failed";
    error = final.errorMessage?.trim() || "provider error with no output";
  } else if (final?.stopReason === "length" && !finalText) {
    outcome = "failed";
    error = "run hit the output token limit before producing any text";
  } else if (wrapRequested) {
    outcome = "wrapped_up";
  } else {
    outcome = "completed";
  }

  const partial = outcome !== "completed" && outcome !== "wrapped_up";
  const labeled = partial && raw ? `Partial output before termination:\n${raw}` : raw;
  const result: ChildRunResult = {
    outcome,
    output: truncateResult(labeled, child.sessionFile, RESULT_CAP_BYTES, statusFor(outcome, error)),
    ...(error ? { error } : {}),
    partial,
    turns,
    sessionFile: child.sessionFile,
    notes: child.notes,
  };
  return result;
});

/** Runs one child to a terminal value; failures never escape into the graph scheduler. */
export function runChildLifecycle(options: ChildRunOptions): Effect.Effect<ChildRunResult> {
  const create = options.create ?? createChildSession;
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => create(options.child),
          catch: (cause) => new PromptFailed({ message: messageFor(cause) }),
        }),
        (acquired) =>
          Effect.promise(() => shutdownChildSession(acquired.session)).pipe(
            Effect.catch(() => Effect.void),
          ),
      );
      return yield* runAcquiredChild(child, options);
    }),
  ).pipe(Effect.catch((failure) => Effect.succeed(startFailure(failure.message))));
}
