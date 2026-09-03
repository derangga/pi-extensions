import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * ANSI 16-color codes, keyed by the name a config file uses. Each pair is
 * [foreground, background].
 *
 * pi-footer emits these through chalk. This package emits them directly: chalk
 * covered only 256-color, truecolor and bold, all of which are either dropped
 * or one escape sequence, and a runtime dependency for that is not a trade
 * worth making.
 */
const NAMED_COLORS = {
  black: [30, 40],
  red: [31, 41],
  green: [32, 42],
  yellow: [33, 43],
  blue: [34, 44],
  magenta: [35, 45],
  cyan: [36, 46],
  white: [37, 47],
  brightBlack: [90, 100],
  brightRed: [91, 101],
  brightGreen: [92, 102],
  brightYellow: [93, 103],
  brightBlue: [94, 104],
  brightMagenta: [95, 105],
  brightCyan: [96, 106],
  brightWhite: [97, 107],
} as const satisfies Record<string, readonly [number, number]>;

/** Leave the terminal's own color alone. Never emits an escape sequence. */
const DEFAULT_COLOR = "default";

export type NamedColor = typeof DEFAULT_COLOR | keyof typeof NAMED_COLORS;
export type ColorName = NamedColor | `pi:${ThemeColor}`;
export type ColorLevel = "ansi" | "none";

const PI_PREFIX = "pi:";

/**
 * NO_COLOR is the cross-ecosystem convention: any non-empty value disables
 * color. Deliberately not `process.stdout.isTTY`, which is one of the few
 * places Bun and Node diverge, and this code is loaded into whichever runtime
 * the user installed pi under.
 */
export function resolveColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  return (env.NO_COLOR ?? "").length > 0 ? "none" : "ansi";
}

export function normalizeColor(value: unknown): ColorName | undefined {
  if (typeof value !== "string") return undefined;
  if (value === DEFAULT_COLOR || Object.hasOwn(NAMED_COLORS, value)) return value as NamedColor;

  // A pi: name is not checked against the theme's color list. Pi's ThemeColor
  // union grew between the versions this package supports, and two of its
  // members are optional per theme, so any list hard-coded here would be wrong
  // for some installation. themeForeground absorbs a name the loaded theme
  // rejects.
  return value.startsWith(PI_PREFIX) && value.length > PI_PREFIX.length
    ? (value as ColorName)
    : undefined;
}

/**
 * Whether the loaded theme defines this color. Callers that choose between a
 * theme color and a fallback have to ask before painting, since Theme.fg throws
 * rather than degrading.
 */
export function hasThemeColor(theme: Theme | undefined, color: ThemeColor): boolean {
  return themeForeground(theme, color, "") !== undefined;
}

export function applyColors(
  text: string,
  foreground: ColorName | undefined,
  background: ColorName | undefined,
  bold: boolean | undefined,
  level: ColorLevel,
  theme?: Theme,
): string {
  if (level === "none") return text;

  let output = text;
  if (foreground && foreground !== DEFAULT_COLOR) output = paint(output, foreground, false, theme);
  if (background && background !== DEFAULT_COLOR) output = paint(output, background, true, theme);
  if (bold) output = `\x1b[1m${output}\x1b[22m`;
  return output;
}

function paint(text: string, color: ColorName, background: boolean, theme?: Theme): string {
  if (color.startsWith(PI_PREFIX)) {
    // Theme exposes named foregrounds only. Its bg() takes a separate union of
    // background roles, none of which a widget color can name.
    if (background) return text;
    const themeColor = color.slice(PI_PREFIX.length) as ThemeColor;
    return themeForeground(theme, themeColor, text) ?? text;
  }

  const codes = NAMED_COLORS[color as keyof typeof NAMED_COLORS];
  if (!codes) return text;
  return background ? `\x1b[${codes[1]}m${text}\x1b[49m` : `\x1b[${codes[0]}m${text}\x1b[39m`;
}

/**
 * Undefined when the color is unavailable: no theme at all, as on the command
 * path, or a theme that does not define it. Theme.fg throws in the second case,
 * and from Pi 0.84 both thinkingMax and searchMatchText are optional, so this
 * is a live path rather than a defensive one.
 */
function themeForeground(
  theme: Theme | undefined,
  color: ThemeColor,
  text: string,
): string | undefined {
  if (!theme) return undefined;
  try {
    return theme.fg(color, text);
  } catch {
    return undefined;
  }
}

// Keep the escape byte out of a regex literal so oxlint's no-control-regex rule
// does not flag the intentional ANSI matcher. RegExp still receives the ESC
// sequence at runtime.
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * The styleable color bag shared by widget options and the conditional-color
 * helpers. fg and bg are validated ColorName; the warning and danger quartet is
 * raw text from a hand-edited config, normalized through normalizeColor at read
 * time.
 */
export interface ConditionalColorFields {
  fg?: ColorName;
  bg?: ColorName;
  warningFg?: string;
  warningBg?: string;
  dangerFg?: string;
  dangerBg?: string;
}
