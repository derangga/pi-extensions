import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applyColors, BASIC_COLOR_NAMES, normalizeColor, parseHex } from "../src/colors.js";
import { configWithPreset, DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { PRESET_VALUES } from "../src/presets.js";
import { renderStatusbar } from "../src/render.js";
import { activeScheme, COLOR_SCHEMES } from "../src/schemes.js";
import { WidgetStore } from "../src/widgets/store.js";
import { statusbarData } from "./helpers/data.js";
import { partialTheme, taggedTheme } from "./helpers/theme.js";

const mocha = COLOR_SCHEMES["catppuccin-mocha"];

/**
 * The whole no-regression claim of the color-scheme work, pinned against output
 * captured before any of it was wired up.
 *
 * The fixture is bytes, escape sequences and all, not a vitest snapshot: a
 * snapshot regenerates on -u, which is exactly the gesture someone reaches for
 * when this test goes red. This file has to be edited by hand to move.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/default-scheme-output.txt", import.meta.url));

// Every color the presets can reach, so a theme-backed name is exercised as
// well as a plain one.
const THEME = partialTheme([
  "accent",
  "dim",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
]);

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined];

function render(): string {
  const out: string[] = [];
  for (const preset of PRESET_VALUES) {
    const config = configWithPreset(DEFAULT_CONFIG, preset);
    for (const colorLevel of ["none", "ansi", "truecolor"] as const) {
      for (const width of [40, 120]) {
        for (const thinkingLevel of LEVELS) {
          const store = WidgetStore.fromConfig(config);
          const lines = renderStatusbar(store, statusbarData({ thinkingLevel }), width, {
            colorLevel,
            theme: THEME,
            getExtensionStatuses: () => new Map([["other-ext", "busy"]]),
          });
          out.push(`${preset}/${colorLevel}/${width}/${thinkingLevel ?? "none"}`);
          for (const line of lines) out.push(`  ${JSON.stringify(line)}`);
        }
      }
    }
  }
  return `${out.join("\n")}\n`;
}

describe("default color scheme", () => {
  it("renders every preset byte-identically to before the schemes existed", () => {
    expect(render()).toBe(readFileSync(FIXTURE, "utf8"));
  });
});

describe("a named color under an active scheme", () => {
  // catppuccin-mocha's ANSI red. A widget still names "red"; the scheme decides.
  const MOCHA_RED = COLOR_SCHEMES["catppuccin-mocha"].ansi.red;

  it("paints the scheme's hex at truecolor", () => {
    expect(MOCHA_RED).toBe("#f38ba8");
    expect(applyColors("x", "red", undefined, false, "truecolor", undefined, mocha)).toBe(
      "\x1b[38;2;243;139;168mx\x1b[39m",
    );
  });

  it("degrades the scheme's hex to the nearest basic code below truecolor", () => {
    // Not the 31 that "red" alone would emit: the scheme's red is a pastel, and
    // brightRed is the nearest of the sixteen to it.
    expect(applyColors("x", "red", undefined, false, "ansi", undefined, mocha)).toBe(
      "\x1b[91mx\x1b[39m",
    );
    expect(applyColors("x", "red", undefined, false, "ansi")).toBe("\x1b[31mx\x1b[39m");
  });

  it("restyles a background the same way", () => {
    expect(applyColors("x", undefined, "red", false, "truecolor", undefined, mocha)).toBe(
      "\x1b[48;2;243;139;168mx\x1b[49m",
    );
  });

  it("leaves the default sentinel alone, so inherit stays out of a scheme's reach", () => {
    expect(applyColors("x", "default", "default", false, "truecolor", undefined, mocha)).toBe("x");
  });

  it("leaves pi: tokens on Pi's theme", () => {
    // The three places that resolve a pi: token are handed to the scheme by a
    // later issue. Until then a token must still reach Theme.fg untouched.
    expect(applyColors("x", "pi:dim", undefined, false, "truecolor", taggedTheme, mocha)).toBe(
      "<dim>x</dim>",
    );
  });

  it("emits nothing at all when color is off", () => {
    expect(applyColors("x", "red", "blue", true, "none", undefined, mocha)).toBe("x");
  });

  it("restyles every one of the sixteen names", () => {
    // Walked, so a name the scheme redefines but paint fails to look up is a
    // failure here rather than one segment quietly keeping its old code.
    const painted = BASIC_COLOR_NAMES.map(
      (name) =>
        `${name}=${applyColors("x", name, undefined, false, "truecolor", undefined, mocha)}`,
    );
    const expected = BASIC_COLOR_NAMES.map((name) => {
      const [red, green, blue] = parseHex(mocha.ansi[name])!;
      return `${name}=\x1b[38;2;${red};${green};${blue}mx\x1b[39m`;
    });
    expect(painted).toEqual(expected);
  });
});

describe("the colorScheme setting", () => {
  it("ships as default", () => {
    expect(DEFAULT_CONFIG.colorScheme).toBe("default");
  });

  it("keeps a name this build knows", () => {
    expect(normalizeConfig({ colorScheme: "tokyo-night" }).colorScheme).toBe("tokyo-night");
  });

  it("falls back to default for a name it does not, rather than failing to load", () => {
    for (const value of ["gruvbox", "", "Tokyo-Night", 7, null, {}]) {
      expect(normalizeConfig({ colorScheme: value }).colorScheme).toBe("default");
    }
    expect(normalizeConfig({}).colorScheme).toBe("default");
  });

  it("resolves default to no scheme at all, which is what makes it inherit", () => {
    expect(activeScheme("default")).toBeUndefined();
    expect(activeScheme("catppuccin-mocha")).toBe(COLOR_SCHEMES["catppuccin-mocha"]);
  });

  it("still rejects a hex in a per-widget fg", () => {
    // A widget names a slot and the scheme decides what it looks like, which
    // already gives arbitrary colors indirectly: name brightCyan, pick a scheme.
    expect(normalizeColor("#f38ba8")).toBeUndefined();
    expect(normalizeColor("#fff")).toBeUndefined();
  });

  it("paints widget segments through the scheme without any widget knowing", () => {
    const store = WidgetStore.fromConfig({
      ...configWithPreset(DEFAULT_CONFIG, "default"),
      colorScheme: "catppuccin-mocha",
    });
    const lines = renderStatusbar(store, statusbarData({ thinkingLevel: undefined }), 200, {
      colorLevel: "truecolor",
      theme: THEME,
    });
    // git-branch ships fg magenta; the scheme's magenta is #f5c2e7.
    expect(lines[0]).toContain("\x1b[38;2;245;194;231m");
    expect(lines[0]).not.toContain("\x1b[35m");
  });
});
