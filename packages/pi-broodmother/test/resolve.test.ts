import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  formatResolveError,
  modelKey,
  resolveModelRef,
  resolveTasks,
  type ModelSource,
  type ParentChoice,
  type ResolvedTask,
  type TaskChoice,
} from "../src/resolve.js";
import { DEFAULT_SETTINGS, Settings, type SubagentSettings } from "../src/settings.js";
import type { PiModel, ThinkingLevel } from "../src/thinking.js";

function model(fields: Partial<PiModel> & Pick<PiModel, "id" | "provider">): PiModel {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  return { name: fields.id, reasoning: true, ...fields } as unknown as PiModel;
}

const anthropicOpus = model({ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" });
const anthropicHaiku = model({
  provider: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  thinkingLevelMap: { minimal: "min", low: "low", medium: "med", high: "high" },
});
/** The only fixture that opts into xhigh and max, so a clamp has somewhere to fall from. */
const bedrockOpus = model({
  provider: "bedrock",
  id: "claude-opus-5",
  thinkingLevelMap: { xhigh: "xh", max: "max" },
});
const openaiFlat = model({ provider: "openai", id: "gpt-5-20251001", reasoning: false });

const AVAILABLE = [anthropicOpus, anthropicHaiku, bedrockOpus, openaiFlat];

/** The R swap: an array of models and a probe that answers from a table. */
function source(overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    available: () => AVAILABLE,
    probe: async () => undefined,
    ...overrides,
  };
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

const parentOn = (model: PiModel, thinking?: ThinkingLevel): ParentChoice => ({ model, thinking });

interface RunOptions {
  readonly parent?: ParentChoice;
  readonly settings?: Partial<SubagentSettings>;
  readonly source?: Partial<ModelSource>;
}

function resolving(tasks: readonly TaskChoice[], options: RunOptions) {
  return resolveTasks(
    source(options.source),
    options.parent ?? parentOn(anthropicOpus, "medium"),
    tasks,
  ).pipe(Effect.provide(settingsLayer(options.settings)));
}

function run(
  tasks: readonly TaskChoice[],
  options: RunOptions = {},
): Promise<readonly ResolvedTask[]> {
  return Effect.runPromise(resolving(tasks, options));
}

/** Takes the error channel, so the assertion reads the message the caller sees. */
function failure(tasks: readonly TaskChoice[], options: RunOptions = {}): Promise<string> {
  return Effect.runPromise(
    resolving(tasks, options).pipe(Effect.flip, Effect.map(formatResolveError)),
  );
}

describe("resolveModelRef", () => {
  it("takes an exact provider/id before anything else", () => {
    expect(resolveModelRef("bedrock/claude-opus-5", AVAILABLE, "anthropic")).toBe(bedrockOpus);
  });

  it("resolves a bare id against the session's own provider first", () => {
    // Both providers carry this id; the session's wins.
    expect(resolveModelRef("claude-opus-5", AVAILABLE, "bedrock")).toBe(bedrockOpus);
    expect(resolveModelRef("claude-opus-5", AVAILABLE, "anthropic")).toBe(anthropicOpus);
  });

  it("normalizes a dot version to a dash", () => {
    expect(resolveModelRef("claude-haiku-4.5", AVAILABLE, undefined)).toBe(anthropicHaiku);
  });

  it("treats a trailing date stamp as optional in both directions", () => {
    // Dated query, undated registry id.
    expect(resolveModelRef("claude-haiku-4-5-20251001", AVAILABLE, undefined)).toBe(anthropicHaiku);
    // Undated query, dated registry id.
    expect(resolveModelRef("gpt-5", AVAILABLE, undefined)).toBe(openaiFlat);
  });

  it("retries a bare id across providers when the named one does not carry it", () => {
    expect(resolveModelRef("openai/claude-haiku-4-5", AVAILABLE, undefined)).toBe(anthropicHaiku);
  });

  it("returns nothing when the query lands on nothing", () => {
    expect(resolveModelRef("llama-3", AVAILABLE, "anthropic")).toBeUndefined();
  });

  it("never matches a model outside the available set", () => {
    // The set is the auth-configured one, so an absent model is unauthenticated
    // rather than unknown, and resolution is where that has to be caught.
    expect(resolveModelRef("claude-opus-5", [anthropicHaiku], "anthropic")).toBeUndefined();
  });
});

describe("precedence", () => {
  const task: TaskChoice = {
    id: "t1",
    agentFile: { model: "bedrock/claude-opus-5" },
    model: "claude-haiku-4-5",
  };

  it("puts the agent file above the settings menu", async () => {
    const [resolved] = await run([task], { settings: { model: "claude-haiku-4-5" } });
    expect(modelKey(resolved!.model)).toBe("bedrock/claude-opus-5");
    expect(resolved!.modelSource).toBe("agent");
  });

  it("puts the settings menu above the per-task field", async () => {
    const [resolved] = await run([{ id: "t1", model: "claude-haiku-4-5" }], {
      settings: { model: "bedrock/claude-opus-5" },
    });
    expect(modelKey(resolved!.model)).toBe("bedrock/claude-opus-5");
    expect(resolved!.modelSource).toBe("settings");
  });

  it("leaves the per-task field in charge while the setting says inherit", async () => {
    const [resolved] = await run([{ id: "t1", model: "claude-haiku-4-5" }]);
    expect(modelKey(resolved!.model)).toBe("anthropic/claude-haiku-4-5");
    expect(resolved!.modelSource).toBe("task");
  });

  it("falls through to the parent when nothing names a model", async () => {
    const [resolved] = await run([{ id: "t1" }]);
    expect(modelKey(resolved!.model)).toBe("anthropic/claude-opus-5");
    expect(resolved!.modelSource).toBe("parent");
  });
});

describe("validation before any child spawns", () => {
  it("fails the whole call and names the task and the models it could have had", async () => {
    const message = await failure([{ id: "alpha" }, { id: "beta", model: "llama-3" }]);
    expect(message).toContain('Task "beta"');
    expect(message).toContain("anthropic/claude-opus-5");
    expect(message).toContain("bedrock/claude-opus-5");
  });

  it("refuses an unsupported level someone wrote down, naming the supported set", async () => {
    const message = await failure([
      { id: "beta", agent: "scout", model: "claude-haiku-4-5", thinking: "max" },
    ]);
    expect(message).toContain('Task "beta"');
    expect(message).toContain('agent "scout"');
    expect(message).toContain("anthropic/claude-haiku-4-5");
    expect(message).toContain("high");
    expect(message).not.toContain("max |");
  });

  it("clamps rather than fails when the level only rode in from the parent", async () => {
    // Nobody asked for max on this child, so refusing the run would be rude.
    const [resolved] = await run([{ id: "t1", model: "claude-haiku-4-5" }], {
      parent: parentOn(anthropicOpus, "max"),
    });
    expect(resolved!.thinking).toBe("high");
    expect(resolved!.notes[0]).toContain("max");
  });

  it("collapses to off on a model that cannot think at all", async () => {
    const [resolved] = await run([{ id: "t1", model: "gpt-5" }], {
      parent: parentOn(anthropicOpus, "high"),
    });
    expect(resolved!.thinking).toBe("off");
  });

  it("fails when nothing names a model and the session has none", async () => {
    const message = await failure([{ id: "t1" }], {
      parent: { model: undefined, thinking: undefined },
    });
    expect(message).toContain("no model was given");
  });
});

describe("preflight probe", () => {
  it("skips the session's own model", async () => {
    const probed: string[] = [];
    await run([{ id: "t1" }, { id: "t2", model: "claude-haiku-4-5" }], {
      source: {
        probe: async (model) => {
          probed.push(modelKey(model));
          return undefined;
        },
      },
    });
    expect(probed).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("probes a shared model once for the whole batch", async () => {
    const probed: string[] = [];
    await run(
      [
        { id: "t1", model: "claude-haiku-4-5" },
        { id: "t2", model: "claude-haiku-4.5" },
        { id: "t3", model: "bedrock/claude-opus-5" },
      ],
      {
        source: {
          probe: async (model) => {
            probed.push(modelKey(model));
            return undefined;
          },
        },
      },
    );
    expect(probed.sort()).toEqual(["anthropic/claude-haiku-4-5", "bedrock/claude-opus-5"]);
  });

  it("falls back to the session model with a note naming both", async () => {
    const [resolved] = await run([{ id: "t1", model: "bedrock/claude-opus-5" }], {
      source: { probe: async () => "401 invalid api key" },
    });
    expect(modelKey(resolved!.model)).toBe("anthropic/claude-opus-5");
    expect(resolved!.notes[0]).toContain("bedrock/claude-opus-5 failed preflight");
    expect(resolved!.notes[0]).toContain("401 invalid api key");
  });

  it("re-resolves thinking against the fallback, which the check before the probe could not", async () => {
    const [resolved] = await run([{ id: "t1", model: "bedrock/claude-opus-5", thinking: "max" }], {
      parent: parentOn(anthropicHaiku, "medium"),
      source: { probe: async () => "connection reset" },
    });
    expect(modelKey(resolved!.model)).toBe("anthropic/claude-haiku-4-5");
    // "max" passed validation on bedrock/claude-opus-5 and is illegal on the
    // model that will actually run.
    expect(resolved!.thinking).toBe("high");
    expect(resolved!.notes.at(-1)).toContain('using "high"');
  });

  it("treats a thrown probe as a failed one", async () => {
    const [resolved] = await run([{ id: "t1", model: "bedrock/claude-opus-5" }], {
      source: {
        probe: () => Promise.reject(new Error("socket hang up")),
      },
    });
    expect(modelKey(resolved!.model)).toBe("anthropic/claude-opus-5");
    expect(resolved!.notes[0]).toContain("socket hang up");
  });

  it("fails the task when the probe fails and there is nothing to fall back to", async () => {
    const message = await failure([{ id: "t1", model: "bedrock/claude-opus-5" }], {
      parent: { model: undefined, thinking: undefined },
      source: { probe: async () => "401 invalid api key" },
    });
    expect(message).toContain("no model to fall back to");
  });
});
