import { defineWidget } from "../types.js";

export const GitDiffWidget = defineWidget({
  type: "git-diff",
  description: "Inserted and deleted line counts against HEAD",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "", hideWhenEmpty: true },
  properties: [
    { id: "gitDiffMode", kind: "choice", default: "plain", choices: ["plain", "compact"] },
  ],
  icons: { emoji: "📈", nerd: "\u{f0450}" },
  defaultStyle: { fg: "yellow", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    // Outside a repository there is no HEAD to diff against. Its own guard
    // rather than hideWhenEmpty, which the other four git widgets lean on:
    // "(+0,-0)" is never empty, so nothing downstream can suppress it.
    if (!ctx.git.isRepo) {
      return renderWidget("");
    }
    return renderWidget(
      options.gitDiffMode === "compact"
        ? `(+${ctx.git.insertions},-${ctx.git.deletions})`
        : `+${ctx.git.insertions}/-${ctx.git.deletions}`,
    );
  },
});
