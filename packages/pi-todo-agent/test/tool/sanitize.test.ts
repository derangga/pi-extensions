import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../../src/tool/sanitize.js";

describe("sanitizeTerminalText", () => {
  it("strips a complete CSI escape sequence whole", () => {
    // No printable remnants: the sequence goes as one unit, leaving no
    // "[31m" behind to leak styling into the widget.
    expect(sanitizeTerminalText("fix\u001b[31mred\u001b[0m bug")).toBe("fixred bug");
  });

  it("strips the C1 single-byte CSI introducer form", () => {
    expect(sanitizeTerminalText("fix\u009b31mred bug")).toBe("fixred bug");
  });

  it("swallows an unterminated OSC payload to end of string", () => {
    // A real terminal treats an unterminated OSC as swallowing the rest of
    // the input; the sanitizer matches that behavior instead of leaving the
    // payload printable.
    expect(sanitizeTerminalText("title\u001b]0;evil payload")).toBe("title");
  });

  it("strips a terminated OSC sequence with its payload", () => {
    expect(sanitizeTerminalText("a\u001b]0;title\u0007b")).toBe("ab");
    expect(sanitizeTerminalText("a\u001b]0;title\u001b\\b")).toBe("ab");
  });

  it("strips any remaining two-character ESC sequence", () => {
    expect(sanitizeTerminalText("a\u001bBb")).toBe("ab");
  });

  it("replaces newlines, carriage returns, and tabs with spaces", () => {
    // Task fields must not change the widget's row layout, so line
    // separators become spaces rather than being dropped. A CRLF pair
    // yields two spaces, one per control character.
    expect(sanitizeTerminalText("line one\nline two\r\ntab\there")).toBe(
      "line one line two  tab here",
    );
  });

  it("drops other C0 and C1 control characters", () => {
    expect(sanitizeTerminalText("a\u0000\u0007\u009fb")).toBe("ab");
  });

  it("removes bidi embedding, override, isolate, and mark controls", () => {
    // Without this a field could reorder how neighboring output reads.
    expect(sanitizeTerminalText("a\u202eb\u200fc\u2066d\u200ee")).toBe("abcde");
  });

  it("replaces unicode line and paragraph separators with spaces", () => {
    expect(sanitizeTerminalText("a\u2028b\u2029c")).toBe("a b c");
  });

  it("leaves plain model text untouched", () => {
    expect(sanitizeTerminalText("research existing tools")).toBe("research existing tools");
  });
});
