import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import { INHERIT, Settings, type SubagentSettings } from "./settings.js";
import {
  supportedThinkingLevels,
  THINKING_LEVELS,
  type PiModel,
  type ThinkingLevel,
} from "./thinking.js";

/**
 * Which of the four precedence rungs a value came from, kept on the result
 * because the rung decides what happens when the value turns out unusable. A
 * level someone wrote down fails the call; a level inherited from the parent
 * gets clamped, since nobody asked for it on this child.
 */
export type ChoiceSource = "agent" | "settings" | "task" | "parent";

/** What an agent file pins. The loader that reads those files arrives later. */
export interface AgentChoice {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface TaskChoice {
  readonly id: string;
  /** The agent name, carried only so error messages can name it. */
  readonly agent?: string;
  readonly agentFile?: AgentChoice;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface ParentChoice {
  readonly model: PiModel | undefined;
  readonly thinking: ThinkingLevel | undefined;
}

export interface ResolvedTask {
  readonly id: string;
  readonly agent: string | undefined;
  readonly model: PiModel;
  readonly modelSource: ChoiceSource;
  readonly thinking: ThinkingLevel;
  readonly thinkingSource: ChoiceSource;
  /** Every degradation, in the order it happened. The caller shows these. */
  readonly notes: readonly string[];
}

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()("ModelNotFound", {
  task: Schema.String,
  ref: Schema.String,
  available: Schema.Array(Schema.String),
}) {}

export class ThinkingUnsupported extends Schema.TaggedError<ThinkingUnsupported>()(
  "ThinkingUnsupported",
  {
    task: Schema.String,
    agent: Schema.String,
    model: Schema.String,
    level: Schema.String,
    supported: Schema.Array(Schema.String),
  },
) {}

export class NoModelAvailable extends Schema.TaggedError<NoModelAvailable>()("NoModelAvailable", {
  task: Schema.String,
  reason: Schema.String,
}) {}

export type ResolveError = ModelNotFound | ThinkingUnsupported | NoModelAvailable;

/**
 * Everything resolution needs from Pi, narrowed to two calls so a test can
 * supply an array of models and a canned probe answer instead of a registry.
 */
export interface ModelSource {
  readonly available: () => readonly PiModel[];
  /** Resolves to the provider's error message, or undefined when the model works. */
  readonly probe: (model: PiModel, signal: AbortSignal) => Promise<string | undefined>;
}

export function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

export function modelSourceFrom(registry: ExtensionContext["modelRegistry"]): ModelSource {
  return {
    available: () => registry.getAvailable(),
    probe: async (model, signal) => {
      try {
        const reply = await registry.complete(
          model,
          { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
          { maxTokens: 16, signal },
        );
        return reply.stopReason === "error"
          ? (reply.errorMessage ?? "provider returned an error")
          : undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

export function formatResolveError(error: ResolveError): string {
  switch (error._tag) {
    case "ModelNotFound":
      return `Task "${error.task}": model not found: "${error.ref}".\n\nAvailable models:\n${error.available
        .map((id) => `  ${id}`)
        .join("\n")}`;
    case "ThinkingUnsupported": {
      const who = error.agent ? `agent "${error.agent}"` : "no agent";
      const supported = error.supported.length > 0 ? error.supported.join(" | ") : "none";
      return `Task "${error.task}" (${who}): thinking level "${error.level}" is not supported by ${error.model}. Supported: ${supported}.`;
    }
    case "NoModelAvailable":
      return `Task "${error.task}": ${error.reason}`;
  }
}

// --- picking, before anything is looked up -----------------------------------

interface Pick<A> {
  readonly value: A | undefined;
  readonly source: ChoiceSource;
}

/**
 * The precedence, in one place because both fields share it: the agent file,
 * then the settings menu, then the per-task field, then the parent. Both user
 * sources outrank the orchestrator's runtime guess, and the more specific user
 * source wins. `inherit` in settings is what keeps the per-task field alive
 * until the user names something concrete.
 */
function pickModelRef(task: TaskChoice, settings: SubagentSettings): Pick<string> {
  const agent = task.agentFile?.model?.trim();
  if (agent) {
    return { value: agent, source: "agent" };
  }

  const setting = settings.model.trim();
  if (setting && setting !== INHERIT) {
    return { value: setting, source: "settings" };
  }

  const own = task.model?.trim();
  if (own) {
    return { value: own, source: "task" };
  }

  return { value: undefined, source: "parent" };
}

function pickThinking(
  task: TaskChoice,
  settings: SubagentSettings,
  parent: ParentChoice,
): Pick<ThinkingLevel> {
  if (task.agentFile?.thinking) {
    return { value: task.agentFile.thinking, source: "agent" };
  }
  if (settings.thinking !== INHERIT) {
    return { value: settings.thinking, source: "settings" };
  }
  if (task.thinking) {
    return { value: task.thinking, source: "task" };
  }
  return { value: parent.thinking, source: "parent" };
}

// --- model lookup ------------------------------------------------------------

/** Cosmetic punctuation only: `claude-haiku-4.5` and `claude-haiku-4-5` are one query. */
function normalize(text: string): string {
  return text.toLowerCase().replaceAll(".", "-");
}

/**
 * Drops a trailing eight-digit date stamp. Applied to both sides so the
 * optionality runs in both directions: a dated config matches an undated
 * registry id, and a dated registry id matches an undated config.
 */
function undated(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

function score(model: PiModel, query: string): number {
  const id = normalize(model.id);
  const name = normalize(model.name ?? model.id);
  const full = normalize(modelKey(model));

  if (id === query || full === query) {
    return 100;
  }
  if (undated(id) === undated(query) || undated(full) === undated(query)) {
    return 90;
  }
  if (id.includes(query) || full.includes(query)) {
    return 60 + (query.length / id.length) * 30;
  }
  if (name.includes(query)) {
    return 40 + (query.length / name.length) * 20;
  }

  const parts = query.split(/[\s\-/]+/);
  const everyPartLands = parts.every(
    (part) =>
      /^\d{8}$/.test(part) ||
      id.includes(part) ||
      name.includes(part) ||
      normalize(model.provider).includes(part),
  );
  return everyPartLands ? 20 : 0;
}

/**
 * Exact first, so auth is part of resolution rather than a failure that shows
 * up after a prompt has already been assembled: `getAvailable()` is the set
 * with credentials configured, and nothing outside it is a candidate.
 */
export function resolveModelRef(
  ref: string,
  available: readonly PiModel[],
  sessionProvider: string | undefined,
): PiModel | undefined {
  const trimmed = ref.trim();
  if (!trimmed) {
    return undefined;
  }

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const exact = available.find((model) => normalize(modelKey(model)) === normalize(trimmed));
    if (exact) {
      return exact;
    }
  }

  // A bare id resolves against the session's own provider before anything
  // else. Someone who types `claude-haiku-4-5` almost always means the one on
  // the provider they are already authenticated to.
  if (slash === -1 && sessionProvider) {
    const own = available.find(
      (model) => model.provider === sessionProvider && normalize(model.id) === normalize(trimmed),
    );
    if (own) {
      return own;
    }
  }

  const query = normalize(trimmed);
  let best: PiModel | undefined;
  let bestScore = 0;
  for (const model of available) {
    const value = score(model, query);
    if (value > bestScore) {
      bestScore = value;
      best = model;
    }
  }
  if (best && bestScore >= 20) {
    return best;
  }

  // A provider/modelId that matched nothing under that provider retries the
  // bare id everywhere, so the same model on another provider beats silently
  // dropping back to the parent's.
  if (slash > 0) {
    return resolveModelRef(trimmed.slice(slash + 1), available, sessionProvider);
  }

  return undefined;
}

// --- thinking ----------------------------------------------------------------

/** The strongest supported level no stronger than the one asked for. */
function clampThinking(model: PiModel, level: ThinkingLevel): ThinkingLevel {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(level)) {
    return level;
  }

  for (let index = THINKING_LEVELS.indexOf(level); index >= 0; index--) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && supported.includes(candidate)) {
      return candidate;
    }
  }
  return supported[0] ?? "off";
}

// --- the resolver ------------------------------------------------------------

const resolveOne = Effect.fn("Resolve.task")(function* (
  task: TaskChoice,
  settings: SubagentSettings,
  parent: ParentChoice,
  available: readonly PiModel[],
): Effect.fn.Return<ResolvedTask, ResolveError> {
  const wanted = pickModelRef(task, settings);

  let model: PiModel;
  if (wanted.value === undefined) {
    if (!parent.model) {
      return yield* new NoModelAvailable({
        task: task.id,
        reason: "no model was given and the session has none to inherit",
      });
    }
    model = parent.model;
  } else {
    const found = resolveModelRef(wanted.value, available, parent.model?.provider);
    if (!found) {
      return yield* new ModelNotFound({
        task: task.id,
        ref: wanted.value,
        available: available.map(modelKey).sort(),
      });
    }
    model = found;
  }

  const level = pickThinking(task, settings, parent);
  const resolved = yield* resolveThinkingFor(task, model, level);

  return {
    id: task.id,
    agent: task.agent,
    model,
    modelSource: wanted.source,
    thinking: resolved.level,
    thinkingSource: level.source,
    notes: resolved.notes,
  };
});

/**
 * Where the rung earns its keep. A level someone wrote down and a level that
 * merely rode in from the parent session are the same string and want opposite
 * treatment: refuse the first, quietly clamp the second.
 */
const resolveThinkingFor = Effect.fn("Resolve.thinking")(function* (
  task: TaskChoice,
  model: PiModel,
  level: Pick<ThinkingLevel>,
): Effect.fn.Return<{ level: ThinkingLevel; notes: readonly string[] }, ThinkingUnsupported> {
  if (level.value === undefined) {
    return { level: "off" as ThinkingLevel, notes: [] };
  }

  const supported = supportedThinkingLevels(model);
  if (supported.includes(level.value)) {
    return { level: level.value, notes: [] };
  }

  if (level.source !== "parent") {
    return yield* new ThinkingUnsupported({
      task: task.id,
      agent: task.agent ?? "",
      model: modelKey(model),
      level: level.value,
      supported,
    });
  }

  const clamped = clampThinking(model, level.value);
  return {
    level: clamped,
    notes: [
      `session thinking "${level.value}" is not supported by ${modelKey(model)}; using "${clamped}"`,
    ],
  };
});

/**
 * Preflight, one real 16-token request per distinct model that is not the
 * session's own. It is landed rather than cut because the failure it catches is
 * exactly the one a hand-picked model produces: a provider configured once
 * whose key has since expired. Deduplicated per run, so a batch of eight tasks
 * on one model costs one request, not eight.
 */
const probeAll = Effect.fn("Resolve.probe")(function* (
  source: ModelSource,
  models: readonly PiModel[],
  concurrency: number,
) {
  const results = yield* Effect.forEach(
    models,
    Effect.fn("Resolve.probeOne")(function* (model: PiModel) {
      const failure = yield* Effect.tryPromise({
        try: (signal) => source.probe(model, signal),
        // `probe` already reports a provider error as a string; reaching the
        // catch means the call itself threw, which is the same news.
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed(cause instanceof Error ? cause.message : String(cause)),
        ),
      );
      return [modelKey(model), failure] as const;
    }),
    { concurrency },
  );

  return new Map(results.filter(([, failure]) => failure !== undefined) as [string, string][]);
});

/**
 * The one resolver every spawn path goes through. It runs over the whole task
 * list before the run exists, so an unusable pair fails the call with zero
 * children spawned and the message names the task.
 */
export const resolveTasks = Effect.fn("Resolve.tasks")(function* (
  source: ModelSource,
  parent: ParentChoice,
  tasks: readonly TaskChoice[],
): Effect.fn.Return<readonly ResolvedTask[], ResolveError, Settings> {
  const settings = yield* (yield* Settings).current;
  const available = source.available();

  const resolved = yield* Effect.forEach(tasks, (task) =>
    resolveOne(task, settings, parent, available),
  );

  const parentKey = parent.model ? modelKey(parent.model) : undefined;
  const distinct = new Map<string, PiModel>();
  for (const task of resolved) {
    const key = modelKey(task.model);
    if (key !== parentKey) {
      distinct.set(key, task.model);
    }
  }

  const failures = yield* probeAll(source, [...distinct.values()], settings.concurrency);
  if (failures.size === 0) {
    return resolved;
  }

  return yield* Effect.forEach(resolved, (task) =>
    applyProbe(task, failures.get(modelKey(task.model)), parent),
  );
});

/**
 * A model that failed preflight falls back to the session's, carrying a note
 * that names both. The thinking level is resolved again against the fallback,
 * because the pair that was checked is not the pair that will run, and this
 * time it clamps rather than fails: the swap is ours, not the caller's.
 */
const applyProbe = Effect.fn("Resolve.fallback")(function* (
  task: ResolvedTask,
  failure: string | undefined,
  parent: ParentChoice,
): Effect.fn.Return<ResolvedTask, NoModelAvailable> {
  if (failure === undefined) {
    return task;
  }

  const failed = modelKey(task.model);
  if (!parent.model) {
    return yield* new NoModelAvailable({
      task: task.id,
      reason: `${failed} failed preflight (${failure}) and the session has no model to fall back to`,
    });
  }

  const clamped = clampThinking(parent.model, task.thinking);
  const notes = [
    ...task.notes,
    `${failed} failed preflight (${failure}); using session model ${modelKey(parent.model)}`,
  ];
  if (clamped !== task.thinking) {
    notes.push(
      `thinking "${task.thinking}" is not supported by ${modelKey(parent.model)}; using "${clamped}"`,
    );
  }

  return { ...task, model: parent.model, thinking: clamped, notes };
});
