import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import { separatorText, SEPARATOR_VALUES } from "../src/separators.js";

describe("separatorText", () => {
  it("gives the exact text for every style", () => {
    expect(separatorText("none")).toBe("");
    expect(separatorText("space")).toBe(" ");
    expect(separatorText("pipe")).toBe(" | ");
    expect(separatorText("dash")).toBe(" - ");
    expect(separatorText("comma")).toBe(", ");
    expect(separatorText("dot")).toBe(" • ");
  });

  it("pads every style but none, so segments never run together", () => {
    for (const style of SEPARATOR_VALUES) {
      if (style === "none") continue;
      expect(separatorText(style).length).toBeGreaterThan(0);
      expect(separatorText(style)).not.toBe(separatorText("none"));
    }
  });

  it("emits the powerline glyph at its own codepoint", () => {
    // U+E0B1 is private use: it renders as the thin left-pointing chevron only
    // in a patched font, and it is exactly the character an editor or a paste
    // path silently turns into a replacement box. Asserting the codepoint
    // rather than a pasted character is the only check that survives that.
    const text = separatorText("powerline");
    expect(text).toHaveLength(3);
    expect(text.codePointAt(1)).toBe(0xe0b1);
    expect(text).toBe(` ${String.fromCodePoint(0xe0b1)} `);
  });

  it("emits a bullet for dot, not a full stop", () => {
    expect(separatorText("dot").codePointAt(1)).toBe(0x2022);
  });
});

describe("separator styles a config can name", () => {
  it("accepts every declared style and keeps it", () => {
    for (const separator of SEPARATOR_VALUES) {
      expect(normalizeConfig({ separator }).separator).toBe(separator);
    }
  });

  it("falls back to the preset's own separator for a style this build dropped", () => {
    // pi-footer carries per-widget powerline variants: left, right, soft and
    // cap. A config written against upstream must land on something renderable
    // rather than on an empty separator.
    expect(normalizeConfig({ separator: "powerline-left" }).separator).toBe("dot");
    expect(normalizeConfig({ separator: 7 }).separator).toBe("dot");
  });
});
