import { describe, expect, it } from "vitest";

import { BASIC_COLOR_NAMES, parseHex } from "../src/colors.js";
import { COLOR_SCHEMES, SCHEME_NAMES, type SchemeName } from "../src/schemes.js";
import { THINKING_LEVELS } from "../src/widgets/utils/thinking.js";

/** Lowercase six-digit hex. A typo has to be a test failure, not a black segment. */
const HEX = /^#[0-9a-f]{6}$/;

const entries = Object.entries(COLOR_SCHEMES) as ReadonlyArray<
  readonly [SchemeName, (typeof COLOR_SCHEMES)[SchemeName]]
>;

describe("COLOR_SCHEMES", () => {
  it("ships the twelve schemes the epic names, and only those", () => {
    expect(SCHEME_NAMES).toEqual([
      "ayu-dark",
      "ayu-light",
      "catppuccin-frappe",
      "catppuccin-latte",
      "catppuccin-macchiato",
      "catppuccin-mocha",
      "github-dark",
      "github-light",
      "tokyo-night",
      "tokyo-night-day",
      "tokyo-night-moon",
      "tokyo-night-storm",
    ]);
  });

  it("has no duplicate names", () => {
    expect(new Set(SCHEME_NAMES).size).toBe(SCHEME_NAMES.length);
  });

  it("walks every scheme and finds all 16 ANSI names", () => {
    // Walked against the color module's own list rather than against each
    // scheme's own keys, which would only prove a scheme agrees with itself.
    expect(BASIC_COLOR_NAMES).toHaveLength(16);
    const expected = [...BASIC_COLOR_NAMES].sort();
    expect(
      Object.fromEntries(entries.map(([name, s]) => [name, Object.keys(s.ansi).sort()])),
    ).toEqual(Object.fromEntries(SCHEME_NAMES.map((name) => [name, expected])));
  });

  it("walks every scheme and finds all 7 thinking levels", () => {
    expect(THINKING_LEVELS).toHaveLength(7);
    const expected = [...THINKING_LEVELS].sort();
    expect(
      Object.fromEntries(entries.map(([name, s]) => [name, Object.keys(s.thinking).sort()])),
    ).toEqual(Object.fromEntries(SCHEME_NAMES.map((name) => [name, expected])));
  });

  it("carries 288 values, every one a lowercase six-digit hex", () => {
    // 16 ANSI names, 7 thinking levels and the dim slot, times twelve.
    const malformed: string[] = [];
    let counted = 0;
    for (const [name, scheme] of entries) {
      for (const key of BASIC_COLOR_NAMES) {
        if (!HEX.test(scheme.ansi[key])) malformed.push(`${name}.ansi.${key}=${scheme.ansi[key]}`);
        counted += 1;
      }
      for (const level of THINKING_LEVELS) {
        const value = scheme.thinking[level];
        if (!HEX.test(value)) malformed.push(`${name}.thinking.${level}=${value}`);
        counted += 1;
      }
      if (!HEX.test(scheme.dim)) malformed.push(`${name}.dim=${scheme.dim}`);
      counted += 1;
    }
    expect(malformed).toEqual([]);
    expect(counted).toBe(288);
  });

  it("gives every scheme a dim that is readable against its own background", () => {
    // The reason dim is its own slot: several projects collapse black and
    // brightBlack onto the same near-black, and ayu-dark publishes #0a0000 for
    // both, so borrowing brightBlack would leave that scheme's separator and
    // status row invisible. Checked as a mid-range brightness, since dim has to
    // sit off the terminal's own background whichever end it is at.
    const tooFlat = entries
      .map(([name, scheme]) => {
        const [red, green, blue] = parseHex(scheme.dim)!;
        return [name, Math.max(red, green, blue) / 255] as const;
      })
      .filter(([, value]) => value < 0.2 || value > 0.85)
      .map(([name, value]) => `${name}=${value.toFixed(2)}`);
    expect(tooFlat).toEqual([]);
  });

  it("flags the light-background schemes in the data, not by their names", () => {
    // catppuccin-latte and tokyo-night-day are light and say so nowhere in
    // their names, which is the reason the flag is a field.
    const light = SCHEME_NAMES.filter((name) => COLOR_SCHEMES[name].light);
    expect(light).toEqual(["ayu-light", "catppuccin-latte", "github-light", "tokyo-night-day"]);
    expect(light.filter((name) => name.includes("light"))).toHaveLength(2);
  });

  it("gives every scheme a thinking ramp of seven distinct colors", () => {
    // The segment's whole job is to say which level is active at a glance. Two
    // levels sharing a color, which is what reading them off the 16 ANSI names
    // would produce, breaks that quietly.
    const collided = entries
      .filter(([, scheme]) => new Set(Object.values(scheme.thinking)).size !== 7)
      .map(([name]) => name);
    expect(collided).toEqual([]);
  });
});
