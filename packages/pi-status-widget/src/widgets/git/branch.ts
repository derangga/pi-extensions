import { defineWidget } from "../types.js";

export const GitBranchWidget = defineWidget({
  type: "git-branch",
  description: "Current branch name, optionally surrounded",
  dependencies: ["git"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [
    {
      id: "gitBranchDisplayStyle",
      kind: "choice",
      default: "default",
      choices: ["default", "round-brackets", "custom"],
    },
    { id: "surroundLeft", kind: "text", default: "" },
    { id: "surroundRight", kind: "text", default: "" },
  ],
  icons: { emoji: "🌿", nerd: "\u{e725}" },
  defaultStyle: { fg: "magenta", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    const branch = ctx.git.branch;
    if (!branch) return renderWidget("");

    if (options.gitBranchDisplayStyle === "round-brackets") return renderWidget(`(${branch})`);
    if (options.gitBranchDisplayStyle === "custom") {
      return renderWidget(`${options.surroundLeft}${branch}${options.surroundRight}`);
    }
    return renderWidget(branch);
  },
});
