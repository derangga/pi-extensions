import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  BORDER_HORIZONTAL_OVERHEAD,
  BORDER_INNER_PADDING_HORIZONTAL,
  BORDER_VERTICAL_OVERHEAD,
  computeBoxDimensions,
  renderBorderedBox,
  stripFenceMarkers,
} from "../src/view/components/preview/preview-box-renderer.js";
import { lineAt } from "./fixtures.js";

/**
 * New suite. Upstream has none for this module, and mutation testing showed
 * why that matters: making `stripFenceMarkers` a no-op left all 411 other
 * tests green. The preview-pane suite mocks pi-tui's `Markdown` with a stub
 * that emits no fenced output, so real fence markers never reach this code
 * through that path.
 */

const ESC = "\x1b";
const BEL = "\x07";
const sgr = (text: string) => `${ESC}[31m${text}${ESC}[0m`;
const osc8Bel = (text: string) => `${ESC}]8;;https://example.com${BEL}${text}${ESC}]8;;${BEL}`;
const osc8St = (text: string) => `${ESC}]8;;https://example.com${ESC}\\${text}${ESC}]8;;${ESC}\\`;

describe("stripFenceMarkers", () => {
  it("drops a bare opening and closing fence", () => {
    expect(stripFenceMarkers(["```ts", "const x = 1;", "```"])).toEqual(["const x = 1;"]);
  });

  it("keeps content that merely contains backticks", () => {
    // Only a line STARTING with three backticks is a fence marker; inline code
    // has already been rendered without them by the time we get here.
    expect(stripFenceMarkers(["use `x` here", "a ``` mid-line"])).toEqual([
      "use `x` here",
      "a ``` mid-line",
    ]);
  });

  it("drops a fence wrapped in SGR colour codes", () => {
    // A highlighter colours the fence, so the raw line starts with an escape
    // rather than a backtick. Testing the escape-stripped form is the point.
    expect(stripFenceMarkers([sgr("```ts"), "body", sgr("```")])).toEqual(["body"]);
  });

  it("drops a fence wrapped in an OSC-8 hyperlink, BEL-terminated", () => {
    expect(stripFenceMarkers([osc8Bel("```"), "body"])).toEqual(["body"]);
  });

  it("drops a fence wrapped in an OSC-8 hyperlink, ST-terminated", () => {
    // The hand-rolled regex this replaced accepted both terminators; the Node
    // builtin must too, or ST-terminated links would leak fence markers.
    expect(stripFenceMarkers([osc8St("```"), "body"])).toEqual(["body"]);
  });

  it("leaves a fence-free block untouched", () => {
    const lines = ["alpha", "beta", ""];
    expect(stripFenceMarkers(lines)).toEqual(lines);
  });

  it("returns a new array rather than mutating its input", () => {
    const input = ["```", "kept"];
    const out = stripFenceMarkers(input);
    expect(input).toHaveLength(2);
    expect(out).toEqual(["kept"]);
  });
});

describe("renderBorderedBox", () => {
  const plain = (s: string) => s;

  it("adds exactly the documented vertical overhead", () => {
    const content = ["alpha", "beta"];
    const { boxWidth } = computeBoxDimensions(content, 60);
    expect(renderBorderedBox(content, boxWidth, plain, 0)).toHaveLength(
      content.length + BORDER_VERTICAL_OVERHEAD,
    );
  });

  it("renders to exactly the box width it was given", () => {
    // `width` here is the TOTAL box width, not the content width: the border
    // and padding are already folded in by computeBoxDimensions, so rendering
    // must not add to it again or the side-by-side columns would overflow.
    const content = ["alpha", "beta"];
    const { innerWidth, boxWidth } = computeBoxDimensions(content, 60);
    expect(boxWidth).toBe(
      innerWidth + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL,
    );
    expect(visibleWidth(lineAt(renderBorderedBox(content, boxWidth, plain, 0), 0))).toBe(boxWidth);
  });

  it("draws corners and sides", () => {
    const out = renderBorderedBox(["x"], 10, plain, 0);
    expect(lineAt(out, 0).startsWith("┌")).toBe(true);
    expect(lineAt(out, 0).endsWith("┐")).toBe(true);
    expect(lineAt(out, out.length - 1).startsWith("└")).toBe(true);
    expect(lineAt(out, out.length - 1).endsWith("┘")).toBe(true);
  });

  it("keeps every row the same visible width", () => {
    // Ragged rows would break the side-by-side column composition.
    const out = renderBorderedBox(["short", "a much longer line"], 40, plain, 0);
    const widths = new Set(out.map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });

  it("reports hidden lines in the bottom border", () => {
    const out = renderBorderedBox(["a"], 40, plain, 5);
    const bottom = lineAt(out, out.length - 1);
    expect(bottom).toContain("5 lines hidden");
  });
});
