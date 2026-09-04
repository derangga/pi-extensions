import { describe, expect, it } from "vitest";

import { cloneConfig, DEFAULT_CONFIG } from "../src/config.js";
import {
  buildPanelItems,
  buildSettingItems,
  commandForSettingChange,
  cycleValue,
  isActionRow,
  ROW_DISMISS,
  ROW_ENABLED,
  ROW_ICONS,
  ROW_PRESET,
  ROW_SEPARATOR,
  stepForKey,
} from "../src/panel.js";
import { SEPARATOR_VALUES } from "../src/separators.js";
import type { StatusbarConfig } from "../src/types.js";

const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const APP_LEFT = "\u001bOD";
const APP_RIGHT = "\u001bOC";

describe("stepForKey", () => {
  it("reads both arrow encodings a terminal can send", () => {
    // A terminal in application cursor mode sends \u001b O D for the same key
    // that sends \u001b [ D normally, and pi switches modes for its own reasons.
    // Recognising one encoding and not the other makes the arrows work until
    // they suddenly do not.
    expect(stepForKey(LEFT)).toBe(-1);
    expect(stepForKey(RIGHT)).toBe(1);
    expect(stepForKey(APP_LEFT)).toBe(-1);
    expect(stepForKey(APP_RIGHT)).toBe(1);
  });

  it("leaves every other key to the list", () => {
    for (const key of ["\u001b[A", "\u001b[B", "\u001b", "\r", " ", "j", "k", "q"]) {
      expect(stepForKey(key)).toBeUndefined();
    }
  });
});

describe("cycleValue", () => {
  const values = ["default", "compact", "git-heavy"];

  it("steps forward and back", () => {
    expect(cycleValue(values, "default", 1)).toBe("compact");
    expect(cycleValue(values, "compact", -1)).toBe("default");
  });

  it("wraps at both ends, so neither arrow dead-ends", () => {
    expect(cycleValue(values, "git-heavy", 1)).toBe("default");
    expect(cycleValue(values, "default", -1)).toBe("git-heavy");
  });

  it("returns to where it started after a full lap", () => {
    let value = "default";
    for (let step = 0; step < values.length; step += 1) value = cycleValue(values, value, 1);
    expect(value).toBe("default");
  });

  it("starts at the first entry for a value not in the list", () => {
    // indexOf returns -1 there, and treating that as a position would land on
    // the last entry going right instead of the first.
    expect(cycleValue(values, "powerline", 1)).toBe("compact");
    expect(cycleValue(values, "powerline", -1)).toBe("git-heavy");
  });

  it("has nothing to cycle in an empty list", () => {
    expect(cycleValue([], "anything", 1)).toBe("anything");
  });
});

describe("buildSettingItems", () => {
  it("offers every separator style the renderer can draw", () => {
    // The row and separatorText are two lists of the same names. A style in
    // one and not the other is either a row that draws nothing or a style
    // nobody can reach.
    const row = buildSettingItems(cloneConfig(DEFAULT_CONFIG)).find(
      (item) => item.id === ROW_SEPARATOR,
    );
    expect(row?.values).toEqual([...SEPARATOR_VALUES]);
  });

  it("offers one row per setting the arrows can change", () => {
    const items = buildSettingItems(cloneConfig(DEFAULT_CONFIG));
    expect(items.map((item) => item.id)).toEqual([
      ROW_PRESET,
      ROW_SEPARATOR,
      ROW_ICONS,
      ROW_ENABLED,
    ]);
  });

  it("shows the value the config actually holds", () => {
    const config: StatusbarConfig = {
      ...cloneConfig(DEFAULT_CONFIG),
      preset: "git-heavy",
      separator: "pipe",
      iconMode: "nerd",
      enabled: false,
    };
    expect(buildSettingItems(config).map((item) => item.currentValue)).toEqual([
      "git-heavy",
      "pipe",
      "nerd",
      "off",
    ]);
  });

  it("gives every row values that cycleValue can walk", () => {
    for (const item of buildSettingItems(cloneConfig(DEFAULT_CONFIG))) {
      expect(item.values?.length ?? 0).toBeGreaterThan(1);
      expect(item.values).toContain(item.currentValue);
    }
  });

  it("keeps every offered value one the command layer accepts", () => {
    // The rows and the parser are two lists of the same names. A preset added
    // to one and not the other shows a row that silently does nothing.
    for (const item of buildSettingItems(cloneConfig(DEFAULT_CONFIG))) {
      for (const value of item.values ?? []) {
        expect(commandForSettingChange(item.id, value)).toBeDefined();
      }
    }
  });
});

describe("commandForSettingChange", () => {
  it("maps each row to its intent", () => {
    expect(commandForSettingChange(ROW_PRESET, "compact")).toEqual({
      kind: "preset",
      preset: "compact",
    });
    expect(commandForSettingChange(ROW_SEPARATOR, "pipe")).toEqual({
      kind: "separator",
      separator: "pipe",
    });
    expect(commandForSettingChange(ROW_ICONS, "nerd")).toEqual({ kind: "icons", iconMode: "nerd" });
    expect(commandForSettingChange(ROW_ENABLED, "off")).toEqual({
      kind: "enabled",
      enabled: false,
    });
    expect(commandForSettingChange(ROW_ENABLED, "on")).toEqual({ kind: "enabled", enabled: true });
  });

  it("commits nothing for a value the row could not have produced", () => {
    expect(commandForSettingChange(ROW_PRESET, "powerline")).toBeUndefined();
    expect(commandForSettingChange(ROW_SEPARATOR, "powerline-left")).toBeUndefined();
    expect(commandForSettingChange(ROW_ICONS, "ascii")).toBeUndefined();
    expect(commandForSettingChange(ROW_ENABLED, "maybe")).toBeUndefined();
    expect(commandForSettingChange("nonsense", "compact")).toBeUndefined();
  });
});

describe("buildPanelItems", () => {
  it("puts the one closing row last, after everything that holds a value", () => {
    const ids = buildPanelItems(cloneConfig(DEFAULT_CONFIG)).map((item) => item.id);
    expect(ids).toEqual([ROW_PRESET, ROW_SEPARATOR, ROW_ICONS, ROW_ENABLED, ROW_DISMISS]);
  });

  it("gives the closing row no values, so the arrows pass over it", () => {
    const rows = buildPanelItems(cloneConfig(DEFAULT_CONFIG));
    const counts = (wanted: boolean) =>
      rows
        .filter((item) => isActionRow(item.id) === wanted)
        .map((item) => item.values?.length ?? 0);

    expect(counts(true)).toEqual([0]);
    expect(counts(false)).toEqual([3, 7, 2, 2]);
  });

  it("leaves the closing row's value column empty", () => {
    // The row is an action, not a setting. A value beside it reads as a
    // promise about what closing does to the changes already applied.
    const rows = buildPanelItems(cloneConfig(DEFAULT_CONFIG));
    expect(rows.find((item) => item.id === ROW_DISMISS)?.currentValue).toBe("");
    expect(rows.at(-1)?.label).toBe("Dismiss");
  });

  it("knows a closing row from a setting", () => {
    expect(isActionRow(ROW_DISMISS)).toBe(true);
    expect(isActionRow(ROW_PRESET)).toBe(false);
    expect(isActionRow(ROW_ICONS)).toBe(false);
    expect(isActionRow(ROW_ENABLED)).toBe(false);
  });
});
