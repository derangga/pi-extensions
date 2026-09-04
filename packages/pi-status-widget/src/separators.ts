export const SEPARATOR_VALUES = [
  "none",
  "dot",
  "pipe",
  "space",
  "dash",
  "comma",
  "powerline",
] as const;

export type SeparatorStyle = (typeof SEPARATOR_VALUES)[number];

/**
 * Text placed between two adjacent segments. pi-footer also carries per-widget
 * separators with left, right, soft and cap powerline variants, all of which
 * existed to build the powerline presets. The powerline style survives as a
 * plain separator for anyone who wants it in a hand-edited config, and needs a
 * patched font like the nerd icon mode does.
 */
export function separatorText(separator: SeparatorStyle): string {
  switch (separator) {
    case "none":
      return "";
    case "space":
      return " ";
    case "pipe":
      return " | ";
    case "dash":
      return " - ";
    case "comma":
      return ", ";
    case "powerline":
      return " \u{e0b1} ";
    case "dot":
      return " • ";
  }
}
