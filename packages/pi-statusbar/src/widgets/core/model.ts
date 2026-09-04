import { defineWidget } from "../types.js";

export const ModelWidget = defineWidget({
  type: "model",
  description: "Active model id, optionally prefixed with its provider",
  dependencies: ["model", "provider"],
  baseOptions: ["raw", "icon"],
  properties: [{ id: "showProvider", kind: "boolean", default: false }],
  icons: { emoji: "🤖", nerd: "\u{f06a9}" },
  defaultStyle: { fg: "cyan", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    const value =
      options.showProvider && ctx.provider
        ? `${ctx.provider}/${ctx.model ?? "no-model"}`
        : (ctx.model ?? "no-model");
    return renderWidget(value);
  },
});
