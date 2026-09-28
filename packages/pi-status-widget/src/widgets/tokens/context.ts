import { defineWidget } from "../types.js";
import { contextColorProperties, contextColors, contextPercent } from "../utils/context.js";
import { formatContextWindow, formatCount } from "../utils/token-format.js";

export const ContextWidget = defineWidget({
  type: "context",
  description: "Context usage percentage and window limit",
  dependencies: ["contextTokens", "contextMaxTokens"],
  baseOptions: ["raw", "icon"],
  properties: contextColorProperties(),
  icons: { emoji: "🧩", nerd: "\u{f035b}" },
  defaultStyle: { fg: "blue", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    return renderWidget(
      contextUsage(ctx.contextTokens, ctx.contextMaxTokens),
      contextColors(options, ctx.contextTokens, ctx.contextMaxTokens),
    );
  },
});

function contextUsage(tokens: number | undefined, maxTokens: number | undefined): string {
  const hasValidWindow = maxTokens !== undefined && maxTokens > 0;
  if (tokens === undefined) {
    return hasValidWindow ? `? (${formatContextWindow(maxTokens)})` : "?";
  }
  // No window size means no percentage to show, so fall back to the raw count.
  if (!hasValidWindow) {
    return `${formatCount(tokens)} ctx`;
  }

  const percent = contextPercent(tokens, maxTokens) ?? 0;
  return `${percent.toFixed(1).replace(/\.0$/, "")}% (${formatContextWindow(maxTokens)})`;
}
