import { defineWidget } from "../types.js";

export const GitAheadBehindWidget = defineWidget({
  type: "git-ahead-behind",
  description: "Commits ahead of and behind the upstream branch",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [],
  icons: { emoji: "↕️", nerd: "\u{f0dd}" },
  defaultStyle: { fg: "cyan", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(ctx.git.isRepo ? `↑${ctx.git.ahead} ↓${ctx.git.behind}` : "");
  },
});
