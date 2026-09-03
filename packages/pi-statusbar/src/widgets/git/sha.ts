import { defineWidget } from "../types.js";

export const GitShaWidget = defineWidget({
  type: "git-sha",
  description: "Short commit SHA of HEAD",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [],
  icons: { emoji: "🔖", nerd: "\u{e729}" },
  defaultStyle: { fg: "brightBlack", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(ctx.git.sha ?? "");
  },
});
