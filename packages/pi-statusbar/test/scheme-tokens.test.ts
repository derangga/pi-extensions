import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { renderStatusbar } from "../src/render.js";
import { COLOR_SCHEMES, SCHEME_NAMES, type ColorScheme } from "../src/schemes.js";
import type { StatusbarSettings, WidgetEntry } from "../src/types.js";
import { contextForDependencies } from "../src/widgets/context.js";
import { registry } from "../src/widgets/registry.js";
import { WidgetStore } from "../src/widgets/store.js";
import { THINKING_LEVELS, thinkingLevelForeground } from "../src/widgets/utils/thinking.js";
import { baseCtx, statusbarData } from "./helpers/data.js";
import { partialTheme, taggedTheme } from "./helpers/theme.js";

/**
 * The three places that resolved a pi: token rather than a named color, so a
 * scheme would otherwise sail straight past them: the thinking ladder, the row
 * of other extensions' statuses, and the separator.
 */
const mocha = COLOR_SCHEMES["catppuccin-mocha"];

/** Escape sequence a hex reaches the screen as at truecolor. */
function truecolor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
}

function settings(overrides: Partial<StatusbarSettings> = {}): StatusbarSettings {
  const { lines: _lines, ...rest } = DEFAULT_CONFIG;
  return { ...rest, separator: "dot", ...overrides };
}

function storeWith(entries: readonly WidgetEntry[], overrides: Partial<StatusbarSettings> = {}) {
  return WidgetStore.fromConfig({ ...settings(overrides), lines: [[...entries]] });
}

describe("the thinking ladder under a scheme", () => {
  it("paints the scheme's own value for every one of the seven levels", () => {
    // Walked, because this segment's color is the package's headline feature:
    // one level left behind is one level visibly from another palette.
    const painted = THINKING_LEVELS.map(
      (level) => `${level}=${thinkingLevelForeground(level, "magenta", taggedTheme, mocha)}`,
    );
    expect(painted).toEqual(THINKING_LEVELS.map((level) => `${level}=${mocha.thinking[level]}`));
  });

  it("never reaches for a pi: token while a scheme is active", () => {
    for (const level of THINKING_LEVELS) {
      expect(thinkingLevelForeground(level, "magenta", taggedTheme, mocha)).not.toMatch(/^pi:/);
    }
  });

  it("keeps taking Pi's theme with no scheme, fallback included", () => {
    expect(thinkingLevelForeground("low", "magenta", taggedTheme)).toBe("pi:thinkingLow");
    // thinkingMax is optional from Pi 0.84, so the named fallback is a live path.
    expect(thinkingLevelForeground("max", "magenta", partialTheme(["thinkingLow"]))).toBe(
      "brightRed",
    );
  });

  it("still honours a level this build does not know, and the colors-off option", () => {
    expect(thinkingLevelForeground("ludicrous", "magenta", taggedTheme, mocha)).toBe("magenta");
    expect(thinkingLevelForeground(undefined, "magenta", taggedTheme, mocha)).toBe("magenta");
  });

  it("reaches the rendered segment, not just the helper", () => {
    const widget = registry.hydrateWidget(registry.createEntry("thinking-level"));
    const ctx = contextForDependencies(
      { ...baseCtx, colorLevel: "truecolor", theme: taggedTheme, scheme: mocha },
      registry.spec("thinking-level").dependencies,
      statusbarData({ thinkingLevel: "high" }),
    );
    expect(widget.render(ctx)).toContain(truecolor(mocha.thinking.high));
  });
});

describe("the dim status row and the separator under a scheme", () => {
  const withStatus = { getExtensionStatuses: () => new Map([["other-ext", "busy"]]) };

  it("paints the status row with the scheme's dim rather than pi:dim", () => {
    const store = storeWith([registry.createEntry("cwd-basename")], {
      colorScheme: "catppuccin-mocha",
    });
    const lines = renderStatusbar(store, statusbarData(), 200, {
      colorLevel: "truecolor",
      theme: taggedTheme,
      ...withStatus,
    });
    expect(lines.at(-1)).toBe(`${truecolor(mocha.dim)}busy\x1b[39m`);
  });

  it("keeps the status row on Pi's theme with no scheme", () => {
    const store = storeWith([registry.createEntry("cwd-basename")]);
    const lines = renderStatusbar(store, statusbarData(), 200, {
      colorLevel: "truecolor",
      theme: taggedTheme,
      ...withStatus,
    });
    expect(lines.at(-1)).toBe("<dim>busy</dim>");
  });

  it("fills in a separator colour the user never chose", () => {
    const entries = [registry.createEntry("cwd-basename"), registry.createEntry("model")];
    const schemed = renderStatusbar(
      storeWith(entries, { colorScheme: "catppuccin-mocha" }),
      statusbarData(),
      200,
      { colorLevel: "truecolor", theme: taggedTheme },
    );
    expect(schemed[0]).toContain(`${truecolor(mocha.dim)} • \x1b[39m`);

    const plain = renderStatusbar(storeWith(entries), statusbarData(), 200, {
      colorLevel: "truecolor",
      theme: taggedTheme,
    });
    expect(plain[0]).toContain(" • ");
    expect(plain[0]).not.toContain(truecolor(mocha.dim));
  });

  it("leaves a separator colour the user did choose to the scheme's ANSI table", () => {
    // An explicit name is still a named slot, so it goes through the sixteen
    // rather than being replaced by dim.
    const entries = [registry.createEntry("cwd-basename"), registry.createEntry("model")];
    const lines = renderStatusbar(
      storeWith(entries, { colorScheme: "catppuccin-mocha", separatorFg: "red" }),
      statusbarData(),
      200,
      { colorLevel: "truecolor", theme: taggedTheme },
    );
    expect(lines[0]).toContain(truecolor(mocha.ansi.red));
    expect(lines[0]).not.toContain(truecolor(mocha.dim));
  });
});

describe("a scheme on a theme that defines nothing", () => {
  // The regression guard: Theme.fg throws on a color the loaded theme omits, and
  // a scheme must not reintroduce that throw. Under a scheme the ladder answers
  // with a hex and Theme.fg is not called for it at all.
  const empty = partialTheme([]);

  it("renders every level without asking the theme for anything", () => {
    for (const name of SCHEME_NAMES) {
      for (const level of THINKING_LEVELS) {
        const store = storeWith([registry.createEntry("thinking-level")], { colorScheme: name });
        expect(() =>
          renderStatusbar(store, statusbarData({ thinkingLevel: level }), 200, {
            colorLevel: "truecolor",
            theme: empty,
            getExtensionStatuses: () => new Map([["other-ext", "busy"]]),
          }),
        ).not.toThrow();
      }
    }
  });

  it("paints the scheme's colour rather than degrading to the named fallback", () => {
    const scheme: ColorScheme = COLOR_SCHEMES["tokyo-night"];
    const store = storeWith([registry.createEntry("thinking-level")], {
      colorScheme: "tokyo-night",
    });
    const lines = renderStatusbar(store, statusbarData({ thinkingLevel: "max" }), 200, {
      colorLevel: "truecolor",
      theme: empty,
    });
    expect(lines[0]).toContain(truecolor(scheme.thinking.max));
  });
});
