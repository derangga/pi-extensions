import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect";

import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.js";

/** Both choice fields use this to mean "whatever the parent session is on". */
export const INHERIT = "inherit";

/** A concrete model id, or INHERIT to follow the parent. */
export type ModelChoice = string;

/** A concrete level, or INHERIT to leave the per-task field in charge. */
export type ThinkingChoice = typeof INHERIT | ThinkingLevel;

export interface SubagentSettings {
  readonly model: ModelChoice;
  readonly thinking: ThinkingChoice;
  readonly concurrency: number;
  readonly maxTurns: number;
}

/** Both bounds are the menu's range as well as the file's. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const MIN_TURNS = 1;
export const MAX_TURNS = 200;

export const DEFAULT_SETTINGS: SubagentSettings = {
  model: INHERIT,
  thinking: INHERIT,
  concurrency: 3,
  maxTurns: 30,
};

const CONFIG_ENV = "PI_SUBAGENT_CONFIG";

export function getSettingsPath(): string {
  return process.env[CONFIG_ENV] ?? join(getAgentDir(), "extensions", "pi-subagent.json");
}

export class SettingsWriteError extends Schema.TaggedError<SettingsWriteError>()(
  "SettingsWriteError",
  { path: Schema.String, message: Schema.String },
) {}

/**
 * A model id is any non-empty string here. Whether it names a model that
 * actually exists is not a question this schema can answer, and asking it twice
 * in two places would let the two answers disagree. Resolution owns it.
 */
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeModel = Schema.decodeUnknownOption(Schema.String);
const decodeThinking = Schema.decodeUnknownOption(Schema.Literals([INHERIT, ...THINKING_LEVELS]));
const decodeConcurrency = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isBetween({ minimum: MIN_CONCURRENCY, maximum: MAX_CONCURRENCY })),
);
const decodeMaxTurns = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isBetween({ minimum: MIN_TURNS, maximum: MAX_TURNS })),
);

type ParseOutcome =
  | { readonly kind: "failed"; readonly warning: string }
  | { readonly kind: "parsed"; readonly value: unknown };

type ReadOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly warning: string }
  | { readonly kind: "read"; readonly text: string };

export interface LoadedSettings {
  readonly settings: SubagentSettings;
  /** Everything the file got wrong. The caller reports these once. */
  readonly warnings: readonly string[];
}

/**
 * Decodes field by field rather than as one struct, so a single bad value costs
 * that field and nothing else. Decoding the whole object at once would throw
 * away three good settings because someone typed a concurrency of 99.
 */
export function decodeSettings(raw: unknown): LoadedSettings {
  const record = decodeRecord(raw);
  if (Option.isNone(record)) {
    return { settings: DEFAULT_SETTINGS, warnings: ["settings file is not an object"] };
  }
  const fields = record.value;

  const warnings: string[] = [];

  const take = <A>(key: string, decode: (input: unknown) => Option.Option<A>, fallback: A): A => {
    if (!Object.hasOwn(fields, key)) return fallback;
    const decoded = decode(fields[key]);
    if (Option.isNone(decoded)) {
      warnings.push(`${key} is out of range, using ${String(fallback)}`);
      return fallback;
    }
    return decoded.value;
  };

  return {
    settings: {
      model: take("model", decodeModel, DEFAULT_SETTINGS.model),
      thinking: take("thinking", decodeThinking, DEFAULT_SETTINGS.thinking),
      concurrency: take("concurrency", decodeConcurrency, DEFAULT_SETTINGS.concurrency),
      maxTurns: take("maxTurns", decodeMaxTurns, DEFAULT_SETTINGS.maxTurns),
    },
    warnings,
  };
}

/**
 * A missing file is the normal first run. A file that exists but cannot be read
 * or parsed falls back to defaults and says why, rather than failing: an
 * unreadable settings file is not worth taking the extension load with it.
 */
/**
 * A missing file is the normal first run. A file that exists but cannot be read
 * or parsed falls back to defaults and says why, rather than failing: an
 * unreadable settings file is not worth taking the extension load with it.
 */
export const loadSettings = Effect.fn("Settings.load")(function* (path: string) {
  const read = yield* Effect.tryPromise({
    try: async (): Promise<ReadOutcome> => ({ kind: "read", text: await readFile(path, "utf8") }),
    catch: (cause) => cause,
  }).pipe(
    // Handled here rather than in a transform below because the two failures
    // part ways: a missing file is the first run and says nothing, while any
    // other read failure is worth a warning. An outer pipe cannot tell them
    // apart from the same error channel.
    Effect.catch((cause) =>
      Effect.succeed<ReadOutcome>(
        isMissingFile(cause)
          ? { kind: "missing" }
          : { kind: "failed", warning: `could not read ${path}: ${messageFor(cause)}` },
      ),
    ),
  );

  if (read.kind === "missing") return { settings: DEFAULT_SETTINGS, warnings: [] };
  if (read.kind === "failed") return { settings: DEFAULT_SETTINGS, warnings: [read.warning] };

  const parsed = yield* Effect.try({
    try: (): ParseOutcome => ({ kind: "parsed", value: JSON.parse(read.text) as unknown }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<ParseOutcome>({
        kind: "failed",
        warning: `${path} is not valid JSON, using defaults: ${messageFor(cause)}`,
      }),
    ),
  );

  if (parsed.kind === "failed") return { settings: DEFAULT_SETTINGS, warnings: [parsed.warning] };

  return decodeSettings(parsed.value);
});

export const saveSettings = Effect.fn("Settings.save")(function* (
  settings: SubagentSettings,
  path: string,
) {
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    },
    catch: (cause) => new SettingsWriteError({ path, message: messageFor(cause) }),
  });
});

export class Settings extends Context.Service<
  Settings,
  {
    /** What the settings are right now. Applies live; nothing caches it. */
    readonly current: Effect.Effect<SubagentSettings>;
    /** Everything wrong with the file at load, for the caller to report once. */
    readonly warnings: readonly string[];
    /** The file the settings came from, printed so it can be hand-edited. */
    readonly path: string;
    update(next: SubagentSettings): Effect.Effect<void, SettingsWriteError>;
  }
>()("pi-subagent/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const path = getSettingsPath();
      const loaded = yield* loadSettings(path);
      const ref = yield* Ref.make(loaded.settings);

      /**
       * Memory first, then disk. A failed write leaves the panel showing what
       * the user chose and reports the failure, which beats silently reverting
       * a row under their cursor.
       */
      const update = Effect.fn("Settings.update")(function* (next: SubagentSettings) {
        yield* Ref.set(ref, next);
        yield* saveSettings(next, path);
      });

      return Settings.of({
        current: Ref.get(ref),
        warnings: loaded.warnings,
        path,
        update,
      });
    }),
  );
}

function isMissingFile(cause: unknown): boolean {
  return Predicate.hasProperty(cause, "code") && cause.code === "ENOENT";
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
