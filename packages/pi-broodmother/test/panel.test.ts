import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SettingsList } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  buildSettingItems,
  CANCEL_HINT,
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
  withDismissHint,
} from "../src/panel.js";
import { DEFAULT_SETTINGS, INHERIT, type SubagentSettings } from "../src/settings.js";
import type { PiModel } from "../src/thinking.js";

function model(id: string, fields: Partial<PiModel> = {}): PiModel {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const raw: unknown = { id, provider: "test", reasoning: true, ...fields };
  return raw as PiModel;
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
      "/tmp/pi-broodmother.json",
    );
    expect(text).toContain("concurrency 4");
    expect(text).toContain("max tasks 6");
    expect(text).toContain("/tmp/pi-broodmother.json");
  });
});

describe("withDismissHint", () => {
  // Pi's SettingsList hardcodes its footer and routes it through theme.hint,
  // so these are the exact strings it sends. If upstream stops sending the
  // first one, the panel keeps working and shows Pi's own wording.
  const FOOTER = "  Enter/Space to change · Esc to cancel";
  const SEARCH_FOOTER = "  Type to search · Enter/Space to change · Esc to cancel";
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const rawBase: unknown = { hint: (text: string) => `[${text}]` };
  const base = rawBase as Parameters<typeof withDismissHint>[0];
  const noop = () => {};
  const plain = {
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: ">",
    hint: (text: string) => text,
  };

  it("corrects the footer", () => {
    expect(withDismissHint(base).hint(FOOTER)).toBe("[  Enter/Space to change · Esc to dismiss]");
  });

  it("corrects the searchable footer too", () => {
    expect(withDismissHint(base).hint(SEARCH_FOOTER)).toContain("Esc to dismiss");
  });

  it("leaves the phrase out of every other hint Pi sends", () => {
    for (const other of ["  No settings available", "  No matching settings", "  ↓ 3 more"]) {
      expect(withDismissHint(base).hint(other)).toBe(`[${other}]`);
    }
  });

  it("still styles through the theme it wraps", () => {
    // The wrapper rewrites the text and hands it on. Dropping the delegation
    // would lose the colour and read as plain output.
    expect(withDismissHint(base).hint(FOOTER).startsWith("[")).toBe(true);
  });

  it("passes an upstream rewording straight through", () => {
    const reworded = "  Enter/Space to change · Esc to close";
    expect(withDismissHint(base).hint(reworded)).toBe(`[${reworded}]`);
  });

  it("keeps the rest of the theme intact", () => {
    const full = {
      label: (text: string) => text,
      value: (text: string) => text,
      description: (text: string) => text,
      cursor: ">",
      hint: (text: string) => text,
    };
    const wrapped = withDismissHint(full);
    expect(wrapped.cursor).toBe(">");
    expect(wrapped.label("Model", true)).toBe("Model");
  });

  it('puts "dismiss" in the footer Pi actually renders', () => {
    // The strongest form of this check: build Pi's own SettingsList with the
    // wrapped theme and read the line it draws. No hand-copied literal, so an
    // upstream rewording or a change to how the footer is themed shows up here
    // as a failure rather than as "cancel" still sitting on screen.
    const items = buildSettingItems(settings(), AVAILABLE, OPUS);
    const list = new SettingsList(items, items.length, withDismissHint(plain), noop, noop);
    const footer = list.render(80).find((line) => line.includes("Enter/Space"));

    expect(footer).toBeDefined();
    expect(footer).toContain("Esc to dismiss");
    expect(footer).not.toContain("Esc to cancel");
  });

  it("is the only thing standing between the panel and Pi's wording", () => {
    // The same list without the wrapper still says cancel, which is what makes
    // the test above meaningful rather than a tautology.
    const items = buildSettingItems(settings(), AVAILABLE, OPUS);
    const list = new SettingsList(items, items.length, plain, noop, noop);
    const footer = list.render(80).find((line) => line.includes("Enter/Space"));

    expect(footer).toContain("Esc to cancel");
  });

  it("matches the phrase Pi actually ships", () => {
    // The whole rewrite hangs on this phrase being in Pi's own footer.
    // Comparing two of our own literals would pass forever, so read the file
    // Pi ships: a version bump that rewords the footer fails here instead of
    // silently leaving "cancel" on screen.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
    const source = readFileSync(join(dirname(entry), "components", "settings-list.js"), "utf8");
    expect(source).toContain(CANCEL_HINT);
  });
});
