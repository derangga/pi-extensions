import { describe, expect, it } from "vitest";

import { contextForDependencies } from "../src/widgets/context.js";
import { registry } from "../src/widgets/registry.js";
import { thinkingLevelForeground } from "../src/widgets/utils/thinking.js";
import { baseCtx, statusbarData } from "./helpers/data.js";
import { partialTheme, taggedTheme } from "./helpers/theme.js";

const EVERY_LEVEL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Renders the thinking segment the way the footer does, under a given theme. */
function renderThinking(
  level: string | undefined,
  options: Record<string, unknown> = {},
  theme?: ReturnType<typeof partialTheme>,
): string | undefined {
  const widget = registry.hydrateWidget(registry.createEntry("thinking-level", options));
  const ctx = contextForDependencies(
    { ...baseCtx, colorLevel: "ansi", ...(theme ? { theme } : {}) },
    registry.spec("thinking-level").dependencies,
    statusbarData({ thinkingLevel: level }),
  );
  return widget.render(ctx);
}

describe("level to color", () => {
  it("prefers the theme's own color for the level", () => {
    // Matching pi's thinking indicator is the point: a custom theme moves both.
    expect(thinkingLevelForeground("low", "magenta", taggedTheme)).toBe("pi:thinkingLow");
    expect(thinkingLevelForeground("xhigh", "magenta", taggedTheme)).toBe("pi:thinkingXhigh");
  });

  it("covers every level pi can report", () => {
    for (const level of EVERY_LEVEL) {
      expect(thinkingLevelForeground(level, "magenta", taggedTheme)).toMatch(/^pi:thinking/);
    }
  });

  it("falls back to the palette when the theme omits that color", () => {
    // thinkingMax is optional from Pi 0.84, and Theme.fg throws on a color the
    // theme does not define, so this is the path a real install takes.
    const theme = partialTheme(["thinkingHigh"]);
    expect(thinkingLevelForeground("max", "magenta", theme)).toBe("brightRed");
    expect(thinkingLevelForeground("high", "magenta", theme)).toBe("pi:thinkingHigh");
  });

  it("falls back to the palette when there is no theme at all", () => {
    // The command path collects data without a Theme.
    expect(thinkingLevelForeground("medium", "magenta", undefined)).toBe("yellow");
    expect(thinkingLevelForeground("off", "magenta", undefined)).toBe("brightBlack");
  });

  it("gives every level a distinct fallback, so the color says something", () => {
    const fallbacks = EVERY_LEVEL.map((level) =>
      thinkingLevelForeground(level, "magenta", undefined),
    );
    expect(new Set(fallbacks).size).toBe(EVERY_LEVEL.length);
  });

  it("keeps the configured color for a level this build does not know", () => {
    // A level pi adds later, or a stale value. Neither should crash or mislead.
    expect(thinkingLevelForeground("enormous", "magenta", taggedTheme)).toBe("magenta");
    expect(thinkingLevelForeground("", "magenta", taggedTheme)).toBe("magenta");
  });

  it("keeps the configured color when there is no level", () => {
    expect(thinkingLevelForeground(undefined, "magenta", taggedTheme)).toBe("magenta");
    expect(thinkingLevelForeground(undefined, undefined, taggedTheme)).toBeUndefined();
  });
});

describe("thinking widget", () => {
  it("colors itself by level out of the box", () => {
    // No preset sets the option, so the default has to be on.
    expect(renderThinking("medium", { raw: true })).toBe("\x1b[33mmedium\x1b[39m");
    expect(renderThinking("xhigh", { raw: true })).toBe("\x1b[31mxhigh\x1b[39m");
  });

  it("routes through the theme when one is loaded", () => {
    const theme = partialTheme(["thinkingHigh"]);
    expect(renderThinking("high", { raw: true }, theme)).toBe("<thinkingHigh>high</thinkingHigh>");
  });

  it("keeps its configured color when the option is switched off", () => {
    expect(renderThinking("medium", { raw: true, thinkingLevelColors: false })).toBe(
      "\x1b[35mmedium\x1b[39m",
    );
  });

  it("respects an explicitly configured color once coloring is off", () => {
    expect(renderThinking("medium", { raw: true, thinkingLevelColors: false, fg: "green" })).toBe(
      "\x1b[32mmedium\x1b[39m",
    );
  });

  it("still colors the icon and value together", () => {
    expect(renderThinking("low")).toBe("\x1b[36m🧠 low\x1b[39m");
  });

  it("does not throw on a theme that defines nothing", () => {
    // The regression this whole guard exists for: an uncaught Theme.fg throw
    // here would take the footer down on a legal theme.
    const theme = partialTheme([]);
    expect(() => renderThinking("max", {}, theme)).not.toThrow();
    expect(renderThinking("max", { raw: true }, theme)).toBe("\x1b[91mmax\x1b[39m");
  });
});
