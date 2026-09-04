import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { hasThemeColor, type ColorName } from "../../colors.js";

/**
 * Pi's own level union, derived from the accessor rather than re-declared, so a
 * level added upstream becomes a compile error here instead of a silent gap.
 */
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface LevelColor {
  /** The color Pi paints its own thinking indicator with. */
  theme: ThemeColor;
  /** Used when the loaded theme omits that color, or when there is no theme. */
  fallback: ColorName;
}

const LEVEL_COLORS: Record<ThinkingLevel, LevelColor> = {
  off: { theme: "thinkingOff", fallback: "brightBlack" },
  minimal: { theme: "thinkingMinimal", fallback: "blue" },
  low: { theme: "thinkingLow", fallback: "cyan" },
  medium: { theme: "thinkingMedium", fallback: "yellow" },
  high: { theme: "thinkingHigh", fallback: "magenta" },
  xhigh: { theme: "thinkingXhigh", fallback: "red" },
  max: { theme: "thinkingMax", fallback: "brightRed" },
};

/** The seven levels at runtime, taken from the map so the two cannot drift. */
export const THINKING_LEVELS = Object.keys(LEVEL_COLORS) as readonly ThinkingLevel[];

export const THINKING_LEVEL_COLORS_PROPERTY = {
  id: "thinkingLevelColors",
  kind: "boolean",
  default: true,
} as const;

/**
 * The color the thinking segment paints with, in three descending preferences:
 * the theme's own color for that level, a fixed palette when the theme does not
 * define it, and the widget's configured color when the level means nothing to
 * this build.
 *
 * The theme is asked before painting rather than painted and caught, because a
 * widget hands the renderer a color name and not styled text. Theme.fg throws
 * on a color the loaded theme omits, and from Pi 0.84 both thinkingMax and
 * searchMatchText are optional, so the middle preference is a live path.
 */
export function thinkingLevelForeground(
  level: string | undefined,
  configured: ColorName | undefined,
  theme: Theme | undefined,
): ColorName | undefined {
  if (level === undefined) return configured;
  const levelColor = LEVEL_COLORS[level as ThinkingLevel];
  if (!levelColor) return configured;

  return hasThemeColor(theme, levelColor.theme) ? `pi:${levelColor.theme}` : levelColor.fallback;
}
