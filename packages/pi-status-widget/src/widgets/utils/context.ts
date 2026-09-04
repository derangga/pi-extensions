import { normalizeColor, type ColorName, type ConditionalColorFields } from "../../colors.js";
import type { WidgetOptions } from "../../types.js";
import { colorPair } from "./colors.js";

export function contextPercent(
  tokens: number | undefined,
  maxTokens: number | undefined,
): number | undefined {
  if (tokens === undefined || maxTokens === undefined || maxTokens <= 0) return undefined;
  return Math.min(100, Math.max(0, (tokens / maxTokens) * 100));
}

interface ContextColorOptions extends WidgetOptions, ConditionalColorFields {
  contextConditionalColors: boolean;
  contextWarningPercent: number;
  contextDangerPercent: number;
}

/**
 * Picks the color a context widget renders with. Off by default: a segment
 * keeps its configured color until someone opts into the thresholds.
 */
export function contextColors(
  options: ContextColorOptions,
  contextTokens: number | undefined,
  contextMaxTokens: number | undefined,
): { fg?: ColorName; bg?: ColorName } {
  if (!options.contextConditionalColors) return colorPair(options.fg, options.bg);
  const percent = contextPercent(contextTokens, contextMaxTokens);
  if (percent === undefined) return colorPair(options.fg, options.bg);

  if (percent >= options.contextDangerPercent) {
    return colorPair(
      normalizeColor(options.dangerFg) ?? options.fg,
      normalizeColor(options.dangerBg) ?? options.bg,
    );
  }

  if (percent >= options.contextWarningPercent) {
    return colorPair(
      normalizeColor(options.warningFg) ?? options.fg,
      normalizeColor(options.warningBg) ?? options.bg,
    );
  }

  return colorPair(options.fg, options.bg);
}

/**
 * The threshold and color options every context widget shares. The warning and
 * danger colors are text properties rather than validated colors because they
 * arrive from a hand-edited file; the sanitizer normalizes them on read.
 */
export function contextColorProperties() {
  return [
    { id: "contextConditionalColors", kind: "boolean", default: false },
    { id: "contextWarningPercent", kind: "number", default: 70, min: 0, max: 100 },
    { id: "contextDangerPercent", kind: "number", default: 90, min: 0, max: 100 },
    { id: "warningFg", kind: "text", default: "yellow" },
    { id: "warningBg", kind: "text", default: "default" },
    { id: "dangerFg", kind: "text", default: "red" },
    { id: "dangerBg", kind: "text", default: "default" },
  ] as const;
}
