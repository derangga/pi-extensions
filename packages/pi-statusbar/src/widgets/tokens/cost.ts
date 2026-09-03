import { defineWidget } from "../types.js";

export const CostWidget = defineWidget({
  type: "cost",
  description: "Estimated session cost in US dollars",
  dependencies: ["metrics", "usingSubscription"],
  baseOptions: ["raw", "icon"],
  properties: [
    { id: "costFormatStyle", kind: "choice", default: "default", choices: ["default", "compact"] },
    { id: "showSubscription", kind: "boolean", default: false },
  ],
  icons: { emoji: "💸", nerd: "\u{f0af1}" },
  defaultStyle: { fg: "green", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    // Default widens the precision under a dollar, where four decimals are the
    // difference between a number and a rounding artifact.
    const cost =
      options.costFormatStyle === "compact"
        ? `$${ctx.metrics.costUsd.toFixed(3)}`
        : `$${ctx.metrics.costUsd.toFixed(ctx.metrics.costUsd < 1 ? 4 : 2)}`;
    const suffix = options.showSubscription && ctx.usingSubscription ? " (sub)" : "";
    return renderWidget(`${cost}${suffix}`);
  },
});
