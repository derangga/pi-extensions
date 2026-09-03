import { defineWidget } from "../types.js";

export const ThinkingLevelWidget = defineWidget({
  type: "thinking-level",
  description: "Reasoning level, for models that support one",
  dependencies: ["thinkingLevel"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [],
  // Placeholder glyph, inherited from pi-footer. The intended one is a GitHub
  // Copilot nerd glyph; swap the escape below once its codepoint is settled.
  icons: { emoji: "🧠", nerd: "\u{f0208}" },
  defaultStyle: { fg: "magenta", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(ctx.thinkingLevel);
  },
});
