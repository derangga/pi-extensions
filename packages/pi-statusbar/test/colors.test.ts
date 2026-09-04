import { describe, expect, it } from "vitest";

import {
  applyColors,
  hasThemeColor,
  nearestAnsi,
  normalizeColor,
  parseHex,
  resolveColorLevel,
  stripAnsi,
  type BasicColor,
} from "../src/colors.js";
import { partialTheme, taggedTheme, themeWithColorMode } from "./helpers/theme.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

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

  it("lets NO_COLOR win over a truecolor terminal", () => {
    expect(resolveColorLevel({ NO_COLOR: "1" }, themeWithColorMode("truecolor"))).toBe("none");
  });

  it("reads truecolor off the theme rather than the environment", () => {
    // Pi already decided what the terminal can do. A COLORTERM sniff here could
    // disagree with the colors Pi paints two lines above the footer.
    expect(resolveColorLevel({ COLORTERM: "truecolor" })).toBe("ansi");
    expect(resolveColorLevel({}, themeWithColorMode("truecolor"))).toBe("truecolor");
  });

  it("falls back to ansi for any other color mode, and for no theme at all", () => {
    expect(resolveColorLevel({}, themeWithColorMode("256color"))).toBe("ansi");
    expect(resolveColorLevel({}, undefined)).toBe("ansi");
  });

  it("falls back to ansi on a Pi older than the accessor", () => {
    // The peer floor is 0.80 and getColorMode is younger. This call sits inside
    // session_start, where a throw costs the whole footer.
    expect(resolveColorLevel({}, {} as unknown as Theme)).toBe("ansi");
  });
});

describe("parseHex", () => {
  it("splits six hex digits into channels, either case", () => {
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
    expect(parseHex("#ffffff")).toEqual([255, 255, 255]);
    expect(parseHex("#7aa2f7")).toEqual([122, 162, 247]);
    expect(parseHex("#7AA2F7")).toEqual([122, 162, 247]);
  });

  it("rejects shorthand, alpha, missing hash and non-hex digits", () => {
    expect(parseHex("#fff")).toBeUndefined();
    expect(parseHex("#ffffffff")).toBeUndefined();
    expect(parseHex("ffffff")).toBeUndefined();
    expect(parseHex("#gggggg")).toBeUndefined();
    expect(parseHex("red")).toBeUndefined();
  });
});

describe("nearestAnsi", () => {
  // Every code's own canonical hex has to come back as that code, or the
  // downgrade is renaming colors that were already exact.
  const canonical: ReadonlyArray<readonly [string, BasicColor]> = [
    ["#000000", "black"],
    ["#800000", "red"],
    ["#008000", "green"],
    ["#808000", "yellow"],
    ["#000080", "blue"],
    ["#800080", "magenta"],
    ["#008080", "cyan"],
    ["#c0c0c0", "white"],
    ["#808080", "brightBlack"],
    ["#ff0000", "brightRed"],
    ["#00ff00", "brightGreen"],
    ["#ffff00", "brightYellow"],
    ["#0000ff", "brightBlue"],
    ["#ff00ff", "brightMagenta"],
    ["#00ffff", "brightCyan"],
    ["#ffffff", "brightWhite"],
  ];

  it.each(canonical)("maps %s back to its own code, %s", (hex, expected) => {
    expect(nearestAnsi(parseHex(hex)!)).toBe(expected);
  });

  // Hand-picked from the schemes this ladder exists for. RGB distance answers
  // "white" for every one of them, which is the reason the code matches on hue.
  const pastels: ReadonlyArray<readonly [string, BasicColor]> = [
    ["#f38ba8", "brightRed"],
    ["#a6e3a1", "brightGreen"],
    ["#7aa2f7", "brightBlue"],
    ["#89dceb", "brightCyan"],
    ["#f9e2af", "brightYellow"],
  ];

  it.each(pastels)("keeps the hue of the pastel %s, giving %s", (hex, expected) => {
    expect(nearestAnsi(parseHex(hex)!)).toBe(expected);
  });

  it("reads a washed-out color as grey rather than as its faint hue", () => {
    expect(nearestAnsi(parseHex("#c0caf5")!)).toBe("brightWhite");
    expect(nearestAnsi(parseHex("#5c6166")!)).toBe("brightBlack");
    expect(nearestAnsi(parseHex("#24292f")!)).toBe("black");
  });

  it("darkens to the dim code below three quarters brightness", () => {
    expect(nearestAnsi([128, 0, 0])).toBe("red");
    expect(nearestAnsi([192, 0, 0])).toBe("brightRed");
  });

  it("resolves a hue between two codes to the nearer one", () => {
    // Mauve. Its hue is 267deg, which is 27 from blue at 240 and 33 from
    // magenta at 300. Blue is the nearer code, and 16 targets cannot do better.
    expect(nearestAnsi(parseHex("#cba6f7")!)).toBe("brightBlue");
  });

  it("calls a saturated but near-black color black", () => {
    expect(nearestAnsi([32, 0, 0])).toBe("black");
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

  it("emits a 24-bit sequence for a hex at truecolor", () => {
    expect(applyColors("x", "#7aa2f7", undefined, false, "truecolor")).toBe(
      "\x1b[38;2;122;162;247mx\x1b[39m",
    );
    expect(applyColors("x", undefined, "#7aa2f7", false, "truecolor")).toBe(
      "\x1b[48;2;122;162;247mx\x1b[49m",
    );
  });

  it("degrades a hex to the nearest basic code at ansi", () => {
    expect(applyColors("x", "#7aa2f7", undefined, false, "ansi")).toBe("\x1b[94mx\x1b[39m");
    expect(applyColors("x", undefined, "#7aa2f7", false, "ansi")).toBe("\x1b[104mx\x1b[49m");
  });

  it("returns a hex untouched at level none", () => {
    expect(applyColors("x", "#7aa2f7", undefined, true, "none")).toBe("x");
  });

  it("leaves a malformed hex unstyled rather than emitting a broken sequence", () => {
    expect(applyColors("x", "#fff", undefined, false, "truecolor")).toBe("x");
    expect(applyColors("x", "#nothex", undefined, false, "ansi")).toBe("x");
  });

  it("still paints named colors the same way at truecolor", () => {
    // The rung only adds a tier for hexes. A name keeps its own basic code.
    expect(applyColors("x", "red", undefined, false, "truecolor")).toBe("\x1b[31mx\x1b[39m");
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
