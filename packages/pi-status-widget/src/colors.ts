import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import type { ColorScheme } from "./schemes.js";

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

/** The 16 ANSI names without the default sentinel: what a hex degrades to. */
export type BasicColor = keyof typeof NAMED_COLORS;
/**
 * The same 16 names at runtime, so a table keyed by them can be walked rather
 * than sampled. Object.keys widens to string[], hence the cast.
 */
export const BASIC_COLOR_NAMES = Object.keys(NAMED_COLORS) as readonly BasicColor[];
export type NamedColor = typeof DEFAULT_COLOR | BasicColor;
/**
 * Well-formedness is checked when the color is painted, not by the type. TS can
 * only say "starts with #", so parseHex is what actually decides.
 */
export type HexColor = `#${string}`;
export type ColorName = NamedColor | `pi:${ThemeColor}` | HexColor;
export type ColorLevel = "none" | "ansi" | "truecolor";

const PI_PREFIX = "pi:";

/**
 * NO_COLOR is the cross-ecosystem convention: any non-empty value disables
 * color. Deliberately not `process.stdout.isTTY`, which is one of the few
 * places Bun and Node diverge, and this code is loaded into whichever runtime
 * the user installed pi under.
 *
 * Truecolor comes from the theme rather than from COLORTERM. Pi has already
 * decided what the terminal can do, and sniffing the environment here would be
 * a second opinion free to disagree with the colors Pi paints two lines above
 * the footer. No theme means no answer, which lands on "ansi".
 *
 * getColorMode is called optionally because this package peers Pi from 0.80,
 * and the accessor is younger than that floor. A footer that renders in basic
 * colors beats one that throws out of session_start and never mounts.
 */
export function resolveColorLevel(env: NodeJS.ProcessEnv = process.env, theme?: Theme): ColorLevel {
  if ((env.NO_COLOR ?? "").length > 0) return "none";
  return theme?.getColorMode?.() === "truecolor" ? "truecolor" : "ansi";
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

/**
 * The scheme rides along as the last argument rather than folded into an object
 * with level and theme. Seven positional parameters is not a shape to be proud
 * of, but every one of the callers and the assertions that pin their output
 * already spell the first six, and this issue's whole claim is that their bytes
 * do not move.
 */
export function applyColors(
  text: string,
  foreground: ColorName | undefined,
  background: ColorName | undefined,
  bold: boolean | undefined,
  level: ColorLevel,
  theme?: Theme,
  scheme?: ColorScheme,
): string {
  if (level === "none") return text;

  let output = text;
  if (foreground && foreground !== DEFAULT_COLOR) {
    output = paint(output, foreground, false, level, theme, scheme);
  }
  if (background && background !== DEFAULT_COLOR) {
    output = paint(output, background, true, level, theme, scheme);
  }
  if (bold) output = `\x1b[1m${output}\x1b[22m`;
  return output;
}

function paint(
  text: string,
  color: ColorName,
  background: boolean,
  level: ColorLevel,
  theme?: Theme,
  scheme?: ColorScheme,
): string {
  if (color.startsWith(PI_PREFIX)) {
    // Theme exposes named foregrounds only. Its bg() takes a separate union of
    // background roles, none of which a widget color can name.
    if (background) return text;
    const themeColor = color.slice(PI_PREFIX.length) as ThemeColor;
    return themeForeground(theme, themeColor, text) ?? text;
  }

  // The scheme redefines the 16 names, so a widget keeps naming its slot and
  // the scheme decides what that slot looks like. The default sentinel never
  // arrives here, which is what keeps "inherit" outside a scheme's reach.
  let name: string = color;
  if (scheme && isBasicColor(color)) name = scheme.ansi[color];
  if (name.startsWith("#")) {
    const rgb = parseHex(name);
    if (!rgb) return text;
    if (level === "truecolor") {
      const [red, green, blue] = rgb;
      return background
        ? `\x1b[48;2;${red};${green};${blue}m${text}\x1b[49m`
        : `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
    }
    name = nearestAnsi(rgb);
  }

  const codes = NAMED_COLORS[name as BasicColor];
  if (!codes) return text;
  return background ? `\x1b[${codes[1]}m${text}\x1b[49m` : `\x1b[${codes[0]}m${text}\x1b[39m`;
}

function isBasicColor(color: ColorName): color is BasicColor {
  return Object.hasOwn(NAMED_COLORS, color);
}

export type Rgb = readonly [number, number, number];

const HEX_PATTERN = /^#([0-9a-f]{6})$/i;

/** Undefined for anything but six hex digits: no #rgb shorthand, no #rrggbbaa. */
export function parseHex(color: string): Rgb | undefined {
  const match = HEX_PATTERN.exec(color);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The six hue sectors, each as [dim, bright]. Index is the hue rounded to 60deg. */
const HUE_SECTORS = [
  ["red", "brightRed"],
  ["yellow", "brightYellow"],
  ["green", "brightGreen"],
  ["cyan", "brightCyan"],
  ["blue", "brightBlue"],
  ["magenta", "brightMagenta"],
] as const satisfies readonly (readonly [BasicColor, BasicColor])[];

/**
 * Below this saturation a color reads as grey however its channels lean. Set
 * from the schemes themselves: their washed-out foregrounds sit near 0.22 and
 * their palest accents near 0.29, and the cut has to land between the two.
 */
const GREY_SATURATION = 0.25;
/** Below this brightness everything reads as black, saturated or not. */
const BLACK_VALUE = 0.25;
/** Above this brightness a hue sector uses its bright code instead of its dim one. */
const BRIGHT_VALUE = 0.75;

/**
 * The basic color a hex degrades to when the terminal cannot take the hex
 * itself. Matches on hue, then picks dim or bright by brightness.
 *
 * Not nearest-by-RGB-distance, which is the obvious answer and the wrong one:
 * a pastel palette sits closer to grey than to any saturated code, so every
 * scheme would collapse into white and the footer would lose its color
 * altogether. Hue keeps blue blue.
 *
 * ponytail: the 16 basic codes are the whole target set. A 6x6x6 cube tier
 * would land much closer, and is what to add if 256-color terminals ever
 * matter more than they do today.
 */
export function nearestAnsi(rgb: Rgb): BasicColor {
  const [red, green, blue] = rgb;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const value = max / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;

  if (saturation < GREY_SATURATION || value < BLACK_VALUE) {
    if (value < BLACK_VALUE) return "black";
    if (value < 0.55) return "brightBlack";
    return value < 0.9 ? "white" : "brightWhite";
  }

  const delta = max - min;
  const turns =
    max === red
      ? ((green - blue) / delta + 6) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  const [dim, bright] = HUE_SECTORS[Math.round(turns) % 6]!;
  return value < BRIGHT_VALUE ? dim : bright;
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
