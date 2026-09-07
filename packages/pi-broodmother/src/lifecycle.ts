import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Ref, Schema } from "effect";

import {
  createChildSession,
  type ChildSessionOptions,
  type CreatedChildSession,
  shutdownChildSession,
} from "./child.js";

export const GRACE_TURNS = 5;
/** Long enough to say what the child is doing, short enough for one widget line. */
export const ACTIVITY_MAX = 60;
export const WALL_CLOCK_LIMIT_MS = 30 * 60 * 1000;
export const RESULT_CAP_BYTES = 24 * 1024;

const WRAP_UP =
  "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/** What a task looks like while it is still running. */
export interface TaskProgress {
  readonly toolCalls: number;
  /** Input plus output plus cache writes: the work done, not the bill. */
  readonly tokens: number;
  /** The same plus cacheRead: the bill, not the work. */
  readonly billedTokens: number;
  /** Priced by Pi, never here. A model Pi has no rates for contributes zero. */
  readonly cost: number;
  /** The last tool call, as a short phrase. */
  readonly activity: string | undefined;
  readonly sessionFile: string | undefined;
}

export const NO_PROGRESS: TaskProgress = {
  toolCalls: 0,
  tokens: 0,
  billedTokens: 0,
  cost: 0,
  activity: undefined,
  sessionFile: undefined,
};

/**
 * The arguments most worth showing, in the order a reader wants them. Falls
 * back to the first string in the object, because a tool this does not know
 * still has something better to show than its own name.
 */
const ACTIVITY_KEYS = ["pattern", "query", "path", "file_path", "filePath", "command", "name"];

export function describeToolCall(toolName: string, args: unknown): string {
  const verb = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  if (!Predicate.isObject(args)) {
    return verb;
  }

  const fields = args as Record<string, unknown>;
  const candidates = [...ACTIVITY_KEYS.map((key) => fields[key]), ...Object.values(fields)];
  const value = candidates.find(
    (candidate) => Predicate.isString(candidate) && candidate.trim() !== "",
  );
  if (!Predicate.isString(value)) {
    return verb;
  }

  const flat = value.replaceAll(/\s+/g, " ").trim();
  return `${verb} ${flat.length > ACTIVITY_MAX ? `${flat.slice(0, ACTIVITY_MAX)}…` : flat}`;
}

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
  /** Whether the child itself produced text, excluding lifecycle status notes. */
  readonly producedOutput: boolean;
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

export type ChildFactory = (options: ChildSessionOptions) => Promise<LifecycleChild>;

export interface ChildRunOptions {
  readonly child: ChildSessionOptions;
  readonly task: string;
  readonly maxTurns: number;
  readonly graceTurns?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly create?: ChildFactory;
  /** Called as the child works, for the widget. Never on the critical path. */
  readonly onProgress?: (progress: TaskProgress) => void;
}

class PromptFailed extends Schema.TaggedError<PromptFailed>()("PromptFailed", {
  message: Schema.String,
}) {}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assistantText(message: AgentSession["messages"][number]): string {
  if (message.role !== "assistant") {
    return "";
  }
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
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function truncateResult(
  text: string,
  sessionFile: string | undefined,
  maxBytes = RESULT_CAP_BYTES,
  status = "",
): string {
  const full = `${text}${status}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }

  const footer = `\n\n[Output truncated. Full transcript: ${sessionFile ?? "child session unavailable"}]`;
  const suffix = `${status}${footer}`;
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  if (budget <= 0) {
    return sliceUtf8(suffix, maxBytes);
  }
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
    producedOutput: false,
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
  const turnsRef = yield* Ref.make(0);
  const wrapRequestedRef = yield* Ref.make(false);
  const abortedAfterGraceRef = yield* Ref.make(false);
  const stoppedByUserRef = yield* Ref.make(options.signal?.aborted === true);
  const streamedRef = yield* Ref.make("");
  const progressRef = yield* Ref.make(NO_PROGRESS);

  const report = (next: TaskProgress): void => {
    // The subscribe callback is synchronous and outside the Effect fiber, so
    // we update the Ref synchronously via runSync rather than closing over a
    // mutable let. The observer still sees the same values, but the data flow
    // is through Ref instead of variable reassignment.
    Effect.runSync(Ref.set(progressRef, next));
    try {
      options.onProgress?.(next);
    } catch {
      // A widget that throws must not strand the child that was feeding it.
    }
  };

  report({ ...NO_PROGRESS, sessionFile: child.sessionFile });

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      Effect.runSync(Ref.set(streamedRef, ""));
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      Effect.runSync(Ref.update(streamedRef, (current) => current + delta));
    }
    if (event.type === "tool_execution_start") {
      const current = Effect.runSync(Ref.get(progressRef));
      report({
        ...current,
        toolCalls: current.toolCalls + 1,
        activity: describeToolCall(event.toolName, event.args),
      });
      return;
    }
    if (event.type === "message_end") {
      // Accumulated here rather than from getSessionStats, which derives from
      // the message array compaction replaces and so resets when a child
      // compacts.
      //
      // Two totals off one accumulator, because they answer different
      // questions. Each turn's cacheRead is the cached prefix re-read on that
      // one call, so summing it across turns states the bill correctly and
      // overstates the work done. Neither figure is derivable from the other
      // afterwards, so both are kept as they arrive.
      const usage = event.message.role === "assistant" ? event.message.usage : undefined;
      if (usage) {
        const current = Effect.runSync(Ref.get(progressRef));
        const work = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
        report({
          ...current,
          tokens: current.tokens + work,
          billedTokens: current.billedTokens + work + (usage.cacheRead ?? 0),
          cost: current.cost + (usage.cost?.total ?? 0),
        });
      }
      return;
    }
    if (event.type !== "turn_end") {
      return;
    }

    Effect.runSync(Ref.update(turnsRef, (n) => n + 1));
    const turns = Effect.runSync(Ref.get(turnsRef));
    const wrapRequested = Effect.runSync(Ref.get(wrapRequestedRef));
    const abortedAfterGrace = Effect.runSync(Ref.get(abortedAfterGraceRef));
    if (!wrapRequested && turns >= maxTurns) {
      Effect.runSync(Ref.set(wrapRequestedRef, true));
      void session.steer(WRAP_UP).catch(() => undefined);
      return;
    }
    if (wrapRequested && !abortedAfterGrace && turns >= maxTurns + graceTurns) {
      Effect.runSync(Ref.set(abortedAfterGraceRef, true));
      void session.abort().catch(() => undefined);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const waitForStop: Effect.Effect<"stopped"> = options.signal
    ? Effect.callback<"stopped">((resume) => {
        const stop = () => {
          Effect.runSync(Ref.set(stoppedByUserRef, true));
          void session.abort().catch(() => undefined);
          resume(Effect.succeed("stopped"));
        };
        if (options.signal!.aborted) {
          stop();
        } else {
          options.signal!.addEventListener("abort", stop, { once: true });
        }
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
  const streamed = yield* Ref.get(streamedRef);
  const raw = finalText || streamed.trim();

  const turns = yield* Ref.get(turnsRef);
  const wrapRequested = yield* Ref.get(wrapRequestedRef);
  const abortedAfterGrace = yield* Ref.get(abortedAfterGraceRef);
  const stoppedByUser = yield* Ref.get(stoppedByUserRef);

  const { outcome, error }: { outcome: ChildOutcome; error: string | undefined } = (() => {
    if (terminal.kind === "timed_out") {
      return { outcome: "timed_out" as const, error: undefined };
    }
    if (stoppedByUser || terminal.kind === "stopped") {
      return { outcome: "stopped" as const, error: undefined };
    }
    if (abortedAfterGrace) {
      return { outcome: "aborted" as const, error: undefined };
    }
    if (terminal.kind === "failed") {
      return { outcome: "failed" as const, error: terminal.error };
    }
    if (final?.stopReason === "error") {
      return {
        outcome: "failed" as const,
        error: final.errorMessage?.trim() || "provider error with no output",
      };
    }
    if (final?.stopReason === "length" && !finalText) {
      return {
        outcome: "failed" as const,
        error: "run hit the output token limit before producing any text",
      };
    }
    if (wrapRequested) {
      return { outcome: "wrapped_up" as const, error: undefined };
    }
    return { outcome: "completed" as const, error: undefined };
  })();

  const partial = outcome !== "completed" && outcome !== "wrapped_up";
  const labeled = partial && raw ? `Partial output before termination:\n${raw}` : raw;
  const result: ChildRunResult = {
    outcome,
    output: truncateResult(labeled, child.sessionFile, RESULT_CAP_BYTES, statusFor(outcome, error)),
    ...(error ? { error } : {}),
    partial,
    producedOutput: raw.length > 0,
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
