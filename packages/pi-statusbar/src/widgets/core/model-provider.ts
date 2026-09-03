import { defineWidget } from "../types.js";

export const ModelProviderWidget = defineWidget({
  type: "model-provider",
  description: "Provider and model together, as provider/model",
  dependencies: ["model", "provider"],
  baseOptions: ["raw", "icon"],
  properties: [],
  icons: { emoji: "🤖", nerd: "\u{f0129}" },
  defaultStyle: { fg: "cyan", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    const value = ctx.provider
      ? `${ctx.provider}/${ctx.model ?? "no-model"}`
      : (ctx.model ?? "no-model");
    return renderWidget(value);
  },
});
