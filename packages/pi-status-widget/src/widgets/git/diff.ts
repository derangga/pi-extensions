import { defineWidget } from "../types.js";

export const GitDiffWidget = defineWidget({
  type: "git-diff",
  description: "Inserted and deleted line counts against HEAD",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [
    { id: "gitDiffMode", kind: "choice", default: "plain", choices: ["plain", "compact"] },
  ],
  icons: { emoji: "📈", nerd: "\u{f0450}" },
  defaultStyle: { fg: "yellow", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    return renderWidget(
      options.gitDiffMode === "compact"
        ? `(+${ctx.git.insertions},-${ctx.git.deletions})`
        : `+${ctx.git.insertions}/-${ctx.git.deletions}`,
    );
  },
});
