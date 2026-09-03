import { defineWidget } from "../types.js";
import { formatElapsed } from "../utils/session.js";

export const TotalTimeWidget = defineWidget({
  type: "total-time",
  description: "Wall clock since the first entry of the session",
  dependencies: ["metrics"],
  baseOptions: ["raw", "icon"],
  properties: [],
  icons: { emoji: "⏳", nerd: "\u{f051b}" },
  defaultStyle: { fg: "yellow", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    // Read at draw time rather than driven by a timer, so the value is right
    // whenever the footer paints and never repaints just to tick.
    return renderWidget(formatElapsed(ctx.metrics.firstTimestampMs, Date.now()));
  },
});
