import { defineWidget } from "../types.js";

export const GitStatusWidget = defineWidget({
  type: "git-status",
  description: "Staged, unstaged and untracked file counts",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [],
  icons: { emoji: "🔀", nerd: "\u{e702}" },
  defaultStyle: { fg: "yellow", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(
      ctx.git.isRepo ? `+${ctx.git.staged} ±${ctx.git.unstaged} ?${ctx.git.untracked}` : "",
    );
  },
});
