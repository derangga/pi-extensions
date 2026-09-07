import { describe, expect, it } from "vitest";

import {
  buildSettingItems,
  clampThinking,
  cycleValue,
  describeSettings,
  resolveModel,
  ROW_CONCURRENCY,
  ROW_MAX_TASKS,
  ROW_MAX_TURNS,
  ROW_MODEL,
  ROW_THINKING,
  settingsWithRowChange,
  thinkingValues,
} from "../src/panel.js";
import { DEFAULT_SETTINGS, INHERIT, type SubagentSettings } from "../src/settings.js";
import type { PiModel } from "../src/thinking.js";

function model(id: string, fields: Partial<PiModel> = {}): PiModel {
  return { id, provider: "test", reasoning: true, ...fields } as unknown as PiModel;
}

const OPUS = model("claude-opus-5");
const HAIKU = model("claude-haiku-4-5", { reasoning: false });
const AVAILABLE = [OPUS, HAIKU];

function settings(overrides: Partial<SubagentSettings> = {}): SubagentSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("resolveModel", () => {
  it("follows the parent while the row says inherit", () => {
    expect(resolveModel(settings(), AVAILABLE, OPUS)).toBe(OPUS);
  });

  it("uses a concrete pick over the parent", () => {
    expect(resolveModel(settings({ model: "claude-haiku-4-5" }), AVAILABLE, OPUS)).toBe(HAIKU);
  });

  it("falls back to the parent when the saved id names nothing available", () => {
    // A model the user had auth for last week and does not today.
    expect(resolveModel(settings({ model: "gone" }), AVAILABLE, OPUS)).toBe(OPUS);
  });

  it("resolves to nothing when there is no parent and no match", () => {
    expect(resolveModel(settings({ model: "gone" }), AVAILABLE, undefined)).toBeUndefined();
  });
});

describe("thinkingValues", () => {
  it("offers inherit plus whatever the model takes", () => {
    expect(thinkingValues(OPUS)).toEqual([INHERIT, "off", "minimal", "low", "medium", "high"]);
  });

  it("offers inherit and off for a model that cannot reason", () => {
    expect(thinkingValues(HAIKU)).toEqual([INHERIT, "off"]);
  });

  it("offers only inherit when no model resolves", () => {
    expect(thinkingValues(undefined)).toEqual([INHERIT]);
  });
});

describe("clampThinking", () => {
  it("keeps a level the model still supports", () => {
    expect(clampThinking("high", OPUS)).toBe("high");
  });

  it("drops a level the model cannot give", () => {
    expect(clampThinking("high", HAIKU)).toBe(INHERIT);
  });
});

describe("buildSettingItems", () => {
  it("builds the five rows in order", () => {
    const ids = buildSettingItems(settings(), AVAILABLE, OPUS).map((item) => item.id);
    expect(ids).toEqual([ROW_MODEL, ROW_THINKING, ROW_CONCURRENCY, ROW_MAX_TURNS, ROW_MAX_TASKS]);
  });

  it("gives the model row no values, because its list opens a submenu", () => {
    const [modelRow] = buildSettingItems(settings(), AVAILABLE, OPUS);
    expect(modelRow?.values).toBeUndefined();
  });

  it("recomputes the thinking row against whichever model row one resolves to", () => {
    const onOpus = buildSettingItems(settings(), AVAILABLE, OPUS);
    const onHaiku = buildSettingItems(settings({ model: "claude-haiku-4-5" }), AVAILABLE, OPUS);

    expect(onOpus[1]?.values).toContain("high");
    expect(onHaiku[1]?.values).not.toContain("high");
  });

  it("shows the numbers as strings, which is what SettingItem carries", () => {
    const rows = buildSettingItems(
      settings({ concurrency: 5, maxTurns: 50, maxTasks: 4 }),
      AVAILABLE,
      OPUS,
    );
    expect(rows[2]?.currentValue).toBe("5");
    expect(rows[3]?.currentValue).toBe("50");
    expect(rows[4]?.currentValue).toBe("4");
  });
});

describe("settingsWithRowChange", () => {
  it("applies a model pick", () => {
    const next = settingsWithRowChange(settings(), ROW_MODEL, "claude-haiku-4-5", AVAILABLE, OPUS);
    expect(next.model).toBe("claude-haiku-4-5");
  });

  it("drops a thinking level the newly picked model cannot give", () => {
    // The whole point of clamping on the model row: without it this saves
    // `high` against a model that has no `high`, and the failure surfaces
    // later, inside a child that has already started.
    const before = settings({ thinking: "high" });
    const after = settingsWithRowChange(before, ROW_MODEL, "claude-haiku-4-5", AVAILABLE, OPUS);
    expect(after.thinking).toBe(INHERIT);
  });

  it("keeps a thinking level the newly picked model still supports", () => {
    const before = settings({ thinking: "low" });
    const after = settingsWithRowChange(before, ROW_MODEL, "claude-opus-5", AVAILABLE, OPUS);
    expect(after.thinking).toBe("low");
  });

  it("refuses a thinking level the current model does not offer", () => {
    const before = settings({ model: "claude-haiku-4-5" });
    expect(settingsWithRowChange(before, ROW_THINKING, "max", AVAILABLE, OPUS)).toEqual(before);
  });

  it("applies numbers inside their range and refuses them outside", () => {
    const base = settings();
    expect(settingsWithRowChange(base, ROW_CONCURRENCY, "6", AVAILABLE, OPUS).concurrency).toBe(6);
    expect(settingsWithRowChange(base, ROW_CONCURRENCY, "0", AVAILABLE, OPUS)).toEqual(base);
    expect(settingsWithRowChange(base, ROW_CONCURRENCY, "99", AVAILABLE, OPUS)).toEqual(base);
    expect(settingsWithRowChange(base, ROW_MAX_TURNS, "abc", AVAILABLE, OPUS)).toEqual(base);
    expect(settingsWithRowChange(base, ROW_MAX_TASKS, "4", AVAILABLE, OPUS).maxTasks).toBe(4);
    expect(settingsWithRowChange(base, ROW_MAX_TASKS, "0", AVAILABLE, OPUS)).toEqual(base);
    expect(settingsWithRowChange(base, ROW_MAX_TASKS, "17", AVAILABLE, OPUS)).toEqual(base);
  });

  it("ignores a row it does not know", () => {
    const base = settings();
    expect(settingsWithRowChange(base, "nope", "1", AVAILABLE, OPUS)).toEqual(base);
  });
});

describe("cycleValue", () => {
  it("wraps in both directions", () => {
    const values = ["a", "b", "c"];
    expect(cycleValue(values, "c", 1)).toBe("a");
    expect(cycleValue(values, "a", -1)).toBe("c");
  });

  it("starts from the first value when the current one is not in the list", () => {
    expect(cycleValue(["a", "b"], "zzz", 1)).toBe("b");
  });

  it("leaves an empty list alone", () => {
    expect(cycleValue([], "a", 1)).toBe("a");
  });
});

describe("describeSettings", () => {
  it("names every setting and the file to hand-edit", () => {
    const text = describeSettings(
      settings({ concurrency: 4, maxTasks: 6 }),
      "/tmp/pi-subagent.json",
    );
    expect(text).toContain("concurrency 4");
    expect(text).toContain("max tasks 6");
    expect(text).toContain("/tmp/pi-subagent.json");
  });
});
