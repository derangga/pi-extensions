import { defineWidget } from "../types.js";

export const FlexSeparatorWidget = defineWidget({
  type: "flex-separator",
  description: "Pushes the widgets after it to the right edge of the line",
  dependencies: [],
  baseOptions: [],
  properties: [
    {
      // Structural: a flex separator marks a split point and renders no text of
      // its own, so an empty render must disappear rather than fall back to the
      // placeholder every other widget uses.
      id: "hideWhenEmpty",
      kind: "boolean",
      default: true,
    },
  ],
  icons: { emoji: "", nerd: "" },
  defaultStyle: { fg: "default", bg: "default", bold: false },
  render({ renderWidget }) {
    return renderWidget("");
  },
});
