import { sep } from "node:path";
import { moveCaretToEnd, splitPath } from "../src/picker.js";
import { CURSOR_MARKER, Input } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

/** Where the caret sits in a focused Input, measured from the rendered line. */
function caretColumn(input: Input): number {
  return (input.render(40)[0] ?? "").indexOf(CURSOR_MARKER);
}

describe("splitPath", () => {
  it("splits at the last separator, keeping it on the directory side", () => {
    expect(splitPath(`..${sep}`)).toEqual({ dirPart: `..${sep}`, prefix: "" });
    expect(splitPath(`..${sep}ms-`)).toEqual({ dirPart: `..${sep}`, prefix: "ms-" });
    expect(splitPath(`/Users/you/code/app`)).toEqual({
      dirPart: "/Users/you/code/",
      prefix: "app",
    });
  });

  it("treats a bare name as a filter on the current directory", () => {
    expect(splitPath("neighbour")).toEqual({ dirPart: "", prefix: "neighbour" });
    expect(splitPath("")).toEqual({ dirPart: "", prefix: "" });
  });
});

describe("moveCaretToEnd", () => {
  it("parks the caret after prefilled text instead of in front of it", () => {
    const input = new Input();
    input.focused = true;
    input.setValue(`..${sep}`);
    const before = caretColumn(input);
    moveCaretToEnd(input);
    expect(caretColumn(input)).toBeGreaterThan(before);
  });

  it("puts it after a completed directory name, ready for the next segment", () => {
    const input = new Input();
    input.focused = true;
    input.setValue(`..${sep}neighbour-repo${sep}`);
    moveCaretToEnd(input);
    // Typing continues the path rather than landing at the front of it.
    input.handleInput("s");
    expect(input.getValue()).toBe(`..${sep}neighbour-repo${sep}s`);
  });
});
