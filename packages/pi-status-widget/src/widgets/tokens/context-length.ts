import { defineWidget } from "../types.js";
import { contextColorProperties, contextColors } from "../utils/context.js";
import { formatTokenCount, tokenFormatStyleProperty } from "../utils/token-format.js";

export const ContextLengthWidget = defineWidget({
  type: "context-length",
  description: "Context size as a token count",
  dependencies: ["contextTokens", "contextMaxTokens"],
  baseOptions: ["raw", "hideWhenZero", "icon"],
  properties: [tokenFormatStyleProperty(), ...contextColorProperties()],
  icons: { emoji: "📏", nerd: "\u{f035b}" },
  defaultStyle: { fg: "brightBlack", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    return renderWidget(
      ctx.contextTokens === undefined
        ? "?"
        : formatTokenCount(ctx.contextTokens, options.tokenFormatStyle),
      contextColors(options, ctx.contextTokens, ctx.contextMaxTokens),
    );
  },
});
