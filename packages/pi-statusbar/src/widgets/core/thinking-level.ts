import { colorPair } from "../utils/colors.js";
import { THINKING_LEVEL_COLORS_PROPERTY, thinkingLevelForeground } from "../utils/thinking.js";
import { defineWidget } from "../types.js";

export const ThinkingLevelWidget = defineWidget({
  type: "thinking-level",
  description: "Reasoning level, colored by the level, for models that support one",
  dependencies: ["thinkingLevel"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [THINKING_LEVEL_COLORS_PROPERTY],
  // Placeholder glyph, inherited from pi-footer. The intended one is a GitHub
  // Copilot nerd glyph; swap the escape below once its codepoint is settled.
  icons: { emoji: "\u{1f9e0}", nerd: "\u{f09d1}" },
  defaultStyle: { fg: "magenta", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    const fg = options.thinkingLevelColors
      ? thinkingLevelForeground(ctx.thinkingLevel, options.fg, ctx.theme, ctx.scheme)
      : options.fg;
    return renderWidget(ctx.thinkingLevel, colorPair(fg, options.bg));
  },
});
