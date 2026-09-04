import type { WidgetEntry } from "../../src/types.js";
import { WidgetInstance } from "../../src/widgets/instance.js";
import type { WidgetSpecUnion } from "../../src/widgets/registry.js";
import { defineWidget, type WidgetSpec } from "../../src/widgets/types.js";

/**
 * A widget exercising every property kind and base option at once. A fixture
 * rather than a shipped widget, so these tests keep asserting the machinery as
 * the widget set changes around them.
 */
// The icons are ASCII markers on purpose. A real nerd glyph is a private-use
// codepoint that does not survive every editor and paste path, and what these
// tests check is which mode was selected, not what the glyph looks like.
export const ProbeWidget = defineWidget({
  type: "probe",
  description: "Test fixture covering every option kind",
  dependencies: ["model", "cwd"],
  baseOptions: ["raw", "hideWhenEmpty", "hideWhenZero", "icon", "text"],
  properties: [
    { id: "flag", kind: "boolean", default: true },
    { id: "count", kind: "number", default: 5, min: 0, max: 10 },
    { id: "mode", kind: "choice", default: "compact", choices: ["compact", "full"] },
    { id: "note", kind: "text", default: "none" },
    { id: "warningFg", kind: "text", default: "yellow" },
  ],
  icons: { emoji: "[emoji]", nerd: "[nerd]" },
  defaultStyle: { fg: "cyan", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(ctx.model);
  },
});

/**
 * Passes a color at render time, the way a conditionally colored widget does.
 * The thinking level and the context thresholds both work this way.
 */
export const OverrideWidget = defineWidget({
  ...ProbeWidget,
  type: "probe-override",
  render({ ctx, renderWidget }) {
    return renderWidget(ctx.model, { fg: "green" });
  },
});

export function instanceFor(
  spec: WidgetSpec<string, never, never, never> | typeof ProbeWidget | typeof OverrideWidget,
  entry: Partial<WidgetEntry> = {},
): WidgetInstance {
  return new WidgetInstance(spec as unknown as WidgetSpecUnion, {
    id: "probe-1",
    type: "flex-separator",
    enabled: true,
    options: {},
    ...entry,
  });
}
