import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  composePrompt,
  formatGraphError,
  planGraph,
  PREVIOUS,
  runGraph,
  type PlannedTask,
  type Settlement,
  type TaskInput,
} from "../src/graph.js";
import { DEFAULT_SETTINGS, MAX_TASKS, Settings, type SubagentSettings } from "../src/settings.js";

function task(fields: Partial<TaskInput> = {}): TaskInput {
  return { task: "look", prompt: "look at the thing", ...fields };
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

function plan(inputs: readonly TaskInput[]): Promise<readonly PlannedTask[]> {
  return Effect.runPromise(planGraph(inputs));
}

/** Takes the error channel, so the assertion reads the message the caller sees. */
function rejected(inputs: readonly TaskInput[]): Promise<string> {
  return Effect.runPromise(planGraph(inputs).pipe(Effect.flip, Effect.map(formatGraphError)));
}

describe("planGraph validation", () => {
  it("refuses an empty call", async () => {
    expect(await rejected([])).toContain("No tasks");
  });

  it("refuses more tasks than the cap", async () => {
    const message = await rejected(Array.from({ length: MAX_TASKS + 1 }, () => task()));
    expect(message).toContain(String(MAX_TASKS + 1));
    expect(message).toContain(String(MAX_TASKS));
  });

  it("accepts exactly the cap", async () => {
    const planned = await plan(Array.from({ length: MAX_TASKS }, () => task()));
    expect(planned).toHaveLength(MAX_TASKS);
  });

  it("takes a tighter cap from the caller", async () => {
    const three = Array.from({ length: 3 }, () => task());
    const message = await Effect.runPromise(
      planGraph(three, 2).pipe(Effect.flip, Effect.map(formatGraphError)),
    );
    expect(message).toContain("The limit is 2");
    expect(await Effect.runPromise(planGraph(three, 3))).toHaveLength(3);
  });

  it("refuses an id outside letters, digits, underscore and hyphen", async () => {
    const message = await rejected([task({ id: "read the docs" })]);
    expect(message).toContain('"read the docs"');
    expect(message).toContain("underscore");
  });

  it("accepts the whole legal charset", async () => {
    const planned = await plan([task({ id: "Read_docs-2" })]);
    expect(planned[0]!.id).toBe("Read_docs-2");
  });

  it("refuses two tasks sharing an explicit id", async () => {
    const message = await rejected([task({ id: "a" }), task({ id: "a" })]);
    expect(message).toContain('"a"');
    expect(message).toContain("unique");
  });

  it("refuses an explicit id that collides with a generated one", async () => {
    // The second task generates "task_2", which the third already claims.
    const message = await rejected([task(), task(), task({ id: "task_2" })]);
    expect(message).toContain("task_2");
    expect(message).toContain("generated");
  });

  it("refuses a self-edge", async () => {
    const message = await rejected([task({ id: "a", needs: ["a"] })]);
    expect(message).toContain('"a" needs itself');
  });

  it("refuses a need that names no task in the call", async () => {
    const message = await rejected([task({ id: "a", needs: ["ghost"] })]);
    expect(message).toContain('"ghost"');
  });

  it("refuses a cycle, naming every task caught in it", async () => {
    const message = await rejected([
      task({ id: "a", needs: ["c"] }),
      task({ id: "b", needs: ["a"] }),
      task({ id: "c", needs: ["b"] }),
      task({ id: "free" }),
    ]);
    expect(message).toContain("a, b, c");
    // The task outside the cycle could have run, so it is not blamed for it.
    expect(message).not.toContain("free");
  });
});

describe("wave assignment", () => {
  it("puts everything in wave zero when nothing has edges", async () => {
    const planned = await plan([task(), task(), task()]);
    expect(planned.map((entry) => entry.wave)).toEqual([0, 0, 0]);
    expect(planned.map((entry) => entry.id)).toEqual(["task_1", "task_2", "task_3"]);
  });

  it("layers a chain one task per wave", async () => {
    const planned = await plan([
      task({ id: "a" }),
      task({ id: "b", needs: ["a"] }),
      task({ id: "c", needs: ["b"] }),
    ]);
    expect(planned.map((entry) => entry.wave)).toEqual([0, 1, 2]);
  });

  it("keeps independent siblings in the same wave rather than pushing each along", async () => {
    // b and c both need a and nothing else, so they are one wave, not two.
    const planned = await plan([
      task({ id: "a" }),
      task({ id: "b", needs: ["a"] }),
      task({ id: "c", needs: ["a"] }),
      task({ id: "d", needs: ["b", "c"] }),
    ]);
    expect(planned.map((entry) => entry.wave)).toEqual([0, 1, 1, 2]);
  });

  it("keeps a task's wave strictly above every need it has", async () => {
    const planned = await plan([
      task({ id: "late", needs: ["early", "mid"] }),
      task({ id: "early" }),
      task({ id: "mid", needs: ["early"] }),
    ]);
    const waves = new Map(planned.map((entry) => [entry.id, entry.wave]));
    for (const entry of planned) {
      for (const need of entry.needs) {
        expect(waves.get(need)!).toBeLessThan(entry.wave);
      }
    }
  });

  it("returns tasks in call order whatever the edges say", async () => {
    const planned = await plan([task({ id: "z", needs: ["a"] }), task({ id: "a" })]);
    expect(planned.map((entry) => entry.id)).toEqual(["z", "a"]);
    expect(planned.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it("drops a duplicated need rather than counting it twice", async () => {
    const planned = await plan([task({ id: "a" }), task({ id: "b", needs: ["a", "a"] })]);
    expect(planned[1]!.needs).toEqual(["a"]);
  });
});

describe("composePrompt", () => {
  const outputs = new Map([
    ["a", "the first answer"],
    ["b", "the second answer"],
  ]);

  it("leaves a prompt with no edges alone", () => {
    expect(composePrompt("just look", [], outputs)).toBe("just look");
  });

  it("says so when the text asks for a previous result it cannot have", () => {
    const composed = composePrompt(`use ${PREVIOUS} somehow`, [], outputs);
    expect(composed).toContain("use  somehow");
    expect(composed).toContain("no upstream");
  });

  it("prepends one named block per need, in order", () => {
    const composed = composePrompt("now synthesize", ["a", "b"], outputs);
    expect(composed).toContain("## Output of a\nthe first answer");
    expect(composed).toContain("## Output of b\nthe second answer");
    expect(composed.indexOf("## Output of a")).toBeLessThan(composed.indexOf("## Output of b"));
    expect(composed.endsWith("now synthesize")).toBe(true);
  });

  it("substitutes the first need wherever the text asks for the previous result", () => {
    const composed = composePrompt(`critique ${PREVIOUS} closely`, ["b", "a"], outputs);
    expect(composed).toContain("critique the second answer closely");
  });

  it("treats the substituted output as text, not as a replacement pattern", () => {
    // A "$&" in a child's output would otherwise re-insert "{previous}" itself.
    // Asserted on the body alone: the named block above it carries the same
    // text verbatim, so a whole-string match would pass either way.
    const composed = composePrompt(PREVIOUS, ["a"], new Map([["a", "cost $& $1 total"]]));
    const body = composed.slice(composed.indexOf("\n---\n"));
    expect(body).toContain("cost $& $1 total");
  });
});

describe("runGraph", () => {
  interface Recorded {
    readonly settlements: readonly Settlement[];
    readonly dispatched: readonly string[];
    readonly prompts: ReadonlyMap<string, string>;
    readonly liveHighWater: number;
  }

  async function execute(
    inputs: readonly TaskInput[],
    outputFor: (id: string) => string | undefined = (id) => `${id} says hello`,
    concurrency = DEFAULT_SETTINGS.concurrency,
  ): Promise<Recorded> {
    const dispatched: string[] = [];
    const prompts = new Map<string, string>();
    let live = 0;
    let liveHighWater = 0;

    const settlements = await Effect.runPromise(
      Effect.gen(function* () {
        const planned = yield* planGraph(inputs);
        return yield* runGraph(planned, (task, prompt) =>
          Effect.gen(function* () {
            live++;
            liveHighWater = Math.max(liveHighWater, live);
            dispatched.push(task.id);
            prompts.set(task.id, prompt);
            // Suspends on purpose. A synchronous stub finishes inside its own
            // tick, so every task looks sequential and the concurrency bound
            // would never be observed either way.
            yield* Effect.sleep("1 millis");
            live--;
            return outputFor(task.id);
          }),
        );
      }).pipe(Effect.provide(settingsLayer({ concurrency }))),
    );

    return { settlements, dispatched, prompts, liveHighWater };
  }

  it("runs a flat batch and settles every task with its output", async () => {
    const { settlements, dispatched } = await execute([task(), task()]);
    expect([...dispatched].sort()).toEqual(["task_1", "task_2"]);
    expect(settlements.map((entry) => entry.output)).toEqual([
      "task_1 says hello",
      "task_2 says hello",
    ]);
  });

  it("gates a dependent behind its upstream", async () => {
    const { dispatched } = await execute([
      task({ id: "b", needs: ["a"] }),
      task({ id: "a" }),
      task({ id: "c", needs: ["b"] }),
    ]);
    expect(dispatched).toEqual(["a", "b", "c"]);
  });

  it("delivers the upstream output into the dependent's prompt", async () => {
    const { prompts } = await execute([
      task({ id: "a" }),
      task({ id: "b", needs: ["a"], prompt: `build on ${PREVIOUS}` }),
    ]);
    expect(prompts.get("b")).toContain("## Output of a\na says hello");
    expect(prompts.get("b")).toContain("build on a says hello");
  });

  it("skips a dependent whose need produced nothing, naming that need", async () => {
    const { settlements, dispatched } = await execute(
      [task({ id: "a" }), task({ id: "b", needs: ["a"] })],
      (id) => (id === "a" ? undefined : "unreachable"),
    );
    expect(dispatched).toEqual(["a"]);
    expect(settlements[1]).toMatchObject({ id: "b", output: undefined, missing: ["a"] });
  });

  it("propagates a skip down the whole chain", async () => {
    const { dispatched, settlements } = await execute(
      [
        task({ id: "a" }),
        task({ id: "b", needs: ["a"] }),
        task({ id: "c", needs: ["b"] }),
        task({ id: "free" }),
      ],
      (id) => (id === "a" ? undefined : "output"),
    );
    // The task with no edges is untouched by the failure beside it.
    expect([...dispatched].sort()).toEqual(["a", "free"]);
    expect(settlements.find((entry) => entry.id === "c")!.missing).toEqual(["b"]);
  });

  it("names only the needs that failed, not every need", async () => {
    const { settlements } = await execute(
      [task({ id: "a" }), task({ id: "b" }), task({ id: "c", needs: ["a", "b"] })],
      (id) => (id === "b" ? undefined : "output"),
    );
    expect(settlements.find((entry) => entry.id === "c")!.missing).toEqual(["b"]);
  });

  it("holds a wave to the configured concurrency", async () => {
    const { liveHighWater } = await execute(
      Array.from({ length: 6 }, () => task()),
      () => "output",
      2,
    );
    expect(liveHighWater).toBeLessThanOrEqual(2);
  });

  it("returns settlements in call order, not settle order", async () => {
    const { settlements } = await execute([
      task({ id: "last", needs: ["first"] }),
      task({ id: "first" }),
    ]);
    expect(settlements.map((entry) => entry.id)).toEqual(["last", "first"]);
  });
});
