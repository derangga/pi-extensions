import { basename } from "node:path";

import { defineWidget } from "../types.js";

export const CwdBasenameWidget = defineWidget({
  type: "cwd-basename",
  description: "Name of the working directory, without its path",
  dependencies: ["cwd"],
  baseOptions: ["raw", "hideWhenEmpty", "icon", "text"],
  baseOptionDefaults: { text: "" },
  properties: [],
  icons: { emoji: "📂", nerd: "\u{e5ff}" },
  defaultStyle: { fg: "blue", bg: "default", bold: false },
  render({ ctx, renderWidget }) {
    return renderWidget(basename(ctx.cwd));
  },
});
