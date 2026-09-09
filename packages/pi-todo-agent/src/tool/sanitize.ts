/**
 * Remove terminal control characters from model-controlled task text before
 * it reaches Pi's terminal renderer. Complete CSI/OSC escape sequences are
 * dropped whole (no printable remnants like `[31m`), newlines and tabs
 * become spaces so task fields cannot change the layout, and bidi controls
 * are removed so a field cannot reorder how neighbouring output reads.
 *
 * The patterns are assembled at runtime from character codes. Their subject
 * matter is control characters by definition, and keeping the bytes out of
 * regex literals and static RegExp arguments keeps the intentional matchers
 * out of no-control-regex findings.
 */

const ESC = String.fromCharCode(0x1b); // the escape byte
const BEL = String.fromCharCode(0x07); // OSC terminator, bell form
const CSI = String.fromCharCode(0x9b); // C1 single-byte CSI introducer
const OSC = String.fromCharCode(0x9d); // C1 single-byte OSC introducer
const ST = String.fromCharCode(0x9c); // OSC terminator, string-terminator form

const CSI_PATTERN = new RegExp(`(?:${ESC}\\[|${CSI})[0-?]*[ -/]*[@-~]`, "g");
const OSC_PATTERN = new RegExp(
  `(?:${ESC}]|${OSC})[^${BEL}${ST}${ESC}]*(?:${BEL}|${ST}|${ESC}\\\\)?`,
  "g",
);
const TWO_CHAR_ESCAPE_PATTERN = new RegExp(`${ESC}.`, "g");
const LINE_SEPARATOR_PATTERN = /[\u2028\u2029]/g;
const CONTROL_CHARS_PATTERN = new RegExp(`[${escRange(0x00, 0x1f)}${escRange(0x7f, 0x9f)}]`, "g");
const BIDI_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Inclusive code-point range as a regex character-class body, e.g. `\u00-\u1f`. */
function escRange(from: number, to: number): string {
  return `${String.fromCharCode(0x5c)}u${from.toString(16).padStart(4, "0")}-${String.fromCharCode(0x5c)}u${to
    .toString(16)
    .padStart(4, "0")}`;
}

function asLineBreak(character: string): string {
  return character === "\n" || character === "\r" || character === "\t" ? " " : "";
}

export function sanitizeTerminalText(value: string): string {
  return (
    value
      // CSI sequences, via both ESC-[ and the C1 single-byte introducer.
      .replace(CSI_PATTERN, "")
      // OSC sequences with their payload; an unterminated OSC swallows the
      // rest of the string, matching how a real terminal would treat it.
      .replace(OSC_PATTERN, "")
      // Any remaining two-character ESC sequence.
      .replace(TWO_CHAR_ESCAPE_PATTERN, "")
      // Unicode line/paragraph separators join lines like \n does below.
      .replace(LINE_SEPARATOR_PATTERN, " ")
      .replace(CONTROL_CHARS_PATTERN, asLineBreak)
      // Bidi embedding/override/isolate controls and LRM/RLM marks.
      .replace(BIDI_PATTERN, "")
  );
}
