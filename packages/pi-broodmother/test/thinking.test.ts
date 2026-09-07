import { describe, expect, it } from "vitest";

import { supportedThinkingLevels, THINKING_LEVELS, type PiModel } from "../src/thinking.js";

/**
 * The rule these pin is asymmetric and easy to get backwards, which is the
 * whole reason it is reimplemented rather than inferred: pi keeps the real
 * function in a nested package it never re-exports.
 */
function model(fields: Partial<PiModel>): PiModel {
  return { id: "test", provider: "test", reasoning: true, ...fields } as unknown as PiModel;
}

describe("supportedThinkingLevels", () => {
  it("collapses a non-reasoning model to off, whatever its map says", () => {
    const levels = supportedThinkingLevels(
      model({ reasoning: false, thinkingLevelMap: { high: "high", max: "max" } }),
    );
    expect(levels).toEqual(["off"]);
  });

  it("treats minimal through high as opt-out when the map is absent", () => {
    expect(supportedThinkingLevels(model({}))).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("treats xhigh and max as opt-in, so a missing key excludes them", () => {
    const levels = supportedThinkingLevels(model({ thinkingLevelMap: { xhigh: "xh" } }));
    expect(levels).toContain("xhigh");
    expect(levels).not.toContain("max");
  });

  it("drops a level the map marks null", () => {
    const levels = supportedThinkingLevels(model({ thinkingLevelMap: { medium: null } }));
    expect(levels).not.toContain("medium");
    expect(levels).toContain("low");
  });

  it("never invents a level outside the known set", () => {
    const levels = supportedThinkingLevels(model({ thinkingLevelMap: { max: "m", xhigh: "x" } }));
    for (const level of levels) {
      expect(THINKING_LEVELS).toContain(level);
    }
  });
});
