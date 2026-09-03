import { describe, expect, it } from "vitest";

import {
  applyColors,
  hasThemeColor,
  normalizeColor,
  resolveColorLevel,
  stripAnsi,
} from "../src/colors.js";
import { partialTheme, taggedTheme } from "./helpers/theme.js";

describe("normalizeColor", () => {
  it("accepts every named color and the default sentinel", () => {
    for (const name of [
      "default",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ]) {
      expect(normalizeColor(name)).toBe(name);
    }
  });

  it("accepts any pi: name without checking it against a theme", () => {
    // Pi's ThemeColor union grew between the supported versions and two members
    // are optional per theme, so a hard-coded list here would reject colors that
    // work. The render path absorbs a name the theme rejects instead.
    expect(normalizeColor("pi:dim")).toBe("pi:dim");
    expect(normalizeColor("pi:thinkingMax")).toBe("pi:thinkingMax");
    expect(normalizeColor("pi:aColorPiHasNotInventedYet")).toBe("pi:aColorPiHasNotInventedYet");
  });

  it("rejects ansi256, bare prefixes, unknown names and non-strings", () => {
    // ansi256 went with the powerline presets and the digit picker that edited it.
    expect(normalizeColor("ansi256:136")).toBeUndefined();
    expect(normalizeColor("pi:")).toBeUndefined();
    expect(normalizeColor("chartreuse")).toBeUndefined();
    expect(normalizeColor("Red")).toBeUndefined();
    expect(normalizeColor(1)).toBeUndefined();
    expect(normalizeColor(undefined)).toBeUndefined();
    expect(normalizeColor({ fg: "red" })).toBeUndefined();
  });
});

describe("resolveColorLevel", () => {
  it("disables color for any non-empty NO_COLOR", () => {
    expect(resolveColorLevel({ NO_COLOR: "1" })).toBe("none");
    expect(resolveColorLevel({ NO_COLOR: "anything" })).toBe("none");
  });

  it("keeps color when NO_COLOR is absent or empty", () => {
    // The convention is that an empty value does not count as set.
    expect(resolveColorLevel({})).toBe("ansi");
    expect(resolveColorLevel({ NO_COLOR: "" })).toBe("ansi");
  });
});

describe("applyColors", () => {
  it("emits the exact foreground sequence", () => {
    expect(applyColors("x", "red", undefined, false, "ansi")).toBe("\x1b[31mx\x1b[39m");
    expect(applyColors("x", "brightWhite", undefined, false, "ansi")).toBe("\x1b[97mx\x1b[39m");
  });

  it("emits the exact background sequence", () => {
    expect(applyColors("x", undefined, "blue", false, "ansi")).toBe("\x1b[44mx\x1b[49m");
  });

  it("emits the exact bold sequence, closing with 22 rather than a full reset", () => {
    // A full reset would clear the colors of whatever the renderer concatenates
    // after this segment.
    expect(applyColors("x", undefined, undefined, true, "ansi")).toBe("\x1b[1mx\x1b[22m");
  });

  it("nests foreground inside background inside bold", () => {
    expect(applyColors("x", "red", "blue", true, "ansi")).toBe(
      "\x1b[1m\x1b[44m\x1b[31mx\x1b[39m\x1b[49m\x1b[22m",
    );
  });

  it("emits nothing for the default sentinel", () => {
    expect(applyColors("x", "default", "default", false, "ansi")).toBe("x");
    expect(applyColors("x", undefined, undefined, false, "ansi")).toBe("x");
  });

  it("returns the input untouched at level none, styles and all", () => {
    expect(applyColors("x", "red", "blue", true, "none")).toBe("x");
    expect(applyColors("x", "pi:dim", undefined, true, "none", taggedTheme)).toBe("x");
  });

  it("delegates a pi: foreground to the theme", () => {
    expect(applyColors("x", "pi:dim", undefined, false, "ansi", taggedTheme)).toBe("<dim>x</dim>");
  });

  it("ignores a pi: background, since Theme exposes no arbitrary background", () => {
    expect(applyColors("x", undefined, "pi:dim", false, "ansi", taggedTheme)).toBe("x");
  });

  it("leaves a pi: color unstyled when there is no theme", () => {
    // The command path collects data with no Theme object at all.
    expect(applyColors("x", "pi:dim", undefined, false, "ansi")).toBe("x");
  });

  it("leaves a pi: color unstyled when the theme does not define it", () => {
    // Theme.fg throws here. An unstyled segment beats a footer that fails to
    // render, which is what an uncaught throw would cost.
    const theme = partialTheme(["dim"]);
    expect(applyColors("x", "pi:thinkingMax", undefined, false, "ansi", theme)).toBe("x");
    expect(applyColors("x", "pi:dim", undefined, false, "ansi", theme)).toBe("<dim>x</dim>");
  });

  it("still applies bold when the theme rejects the color", () => {
    expect(applyColors("x", "pi:thinkingMax", undefined, true, "ansi", partialTheme([]))).toBe(
      "\x1b[1mx\x1b[22m",
    );
  });
});

describe("hasThemeColor", () => {
  it("reports what the loaded theme actually defines", () => {
    const theme = partialTheme(["thinkingHigh", "dim"]);
    expect(hasThemeColor(theme, "thinkingHigh")).toBe(true);
    expect(hasThemeColor(theme, "thinkingMax")).toBe(false);
  });

  it("reports false with no theme, so a caller falls back rather than painting", () => {
    expect(hasThemeColor(undefined, "thinkingHigh")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("removes the sequences this module emits", () => {
    expect(stripAnsi(applyColors("x", "red", "blue", true, "ansi"))).toBe("x");
  });

  it("leaves text without escapes alone", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});
