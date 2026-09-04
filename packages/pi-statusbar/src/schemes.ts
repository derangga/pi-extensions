/**
 * The twelve color schemes, as a table and nothing else.
 *
 * A scheme redefines the color names the widgets already use, so no widget file
 * needs to know a scheme exists: each keeps naming its slot, and the scheme
 * decides what that slot looks like. A color hand-set in the config gets
 * restyled the same way, instead of some names changing and others not.
 *
 * Each scheme carries the full 16-color ANSI palette rather than only the seven
 * names in use. Every upstream project publishes exactly that table, because it
 * is what a terminal theme is, so it is easier to source correctly and easier to
 * check against the original.
 *
 * Foregrounds only. A scheme never fills a background, so the footer keeps
 * sitting on the terminal's own and a light scheme cannot paint a bright band
 * across the bottom of a dark screen. `light` says which terminal background a
 * scheme was drawn for; it is data because two of the light schemes are not
 * called "light".
 *
 * Values come from each project's own published terminal palette, named per
 * scheme below, and not from the third-party ports that also carry these names.
 * The ports drift: alacritty-theme's catppuccin has white and brightWhite the
 * wrong way round, and its github palette is the one GitHub used before 2020.
 * Checking ours against a port will show differences, and ours is the newer
 * side of them. The thinking ramp is the one part no upstream publishes: it is
 * built from each scheme's syntax or accent colors, in a fixed order that has to
 * read as a ramp — a muted grey, then blue, cyan, yellow, purple, orange, red.
 * Which is why the seven ride along as data rather than being read off the
 * sixteen: several schemes put pink in the ANSI magenta slot and keep their real
 * purple outside the table, and two of them have no readable yellow in it.
 */

import type { BasicColor, HexColor } from "./colors.js";
import type { ThinkingLevel } from "./widgets/utils/thinking.js";

export interface ColorScheme {
  /** True when the scheme expects a light terminal background. */
  light: boolean;
  ansi: Record<BasicColor, HexColor>;
  thinking: Record<ThinkingLevel, HexColor>;
}

const SCHEMES = {
  "ayu-dark": {
    // ayu, themes/dark.yaml
    light: false,
    ansi: {
      black: "#0a0000",
      red: "#e6495a",
      green: "#97c142",
      yellow: "#e89d37",
      blue: "#17acf2",
      magenta: "#c385fe",
      cyan: "#84ceb5",
      white: "#ffffff",
      brightBlack: "#0a0000",
      brightRed: "#f07178",
      brightGreen: "#aad94c",
      brightYellow: "#ffb454",
      brightBlue: "#59c2ff",
      brightMagenta: "#d2a6ff",
      brightCyan: "#95e6cb",
      brightWhite: "#ffffff",
    },
    thinking: {
      off: "#5a6673",
      minimal: "#59c2ff",
      low: "#95e6cb",
      medium: "#ffb454",
      high: "#d2a6ff",
      xhigh: "#ff8f40",
      max: "#f07178",
    },
  },
  "ayu-light": {
    // ayu, themes/light.yaml
    light: true,
    ansi: {
      black: "#86878c",
      red: "#f07171",
      green: "#86b300",
      yellow: "#eba400",
      blue: "#22a4e6",
      magenta: "#a37acc",
      cyan: "#4cbf99",
      white: "#adaeb1",
      brightBlack: "#939498",
      brightRed: "#f07171",
      brightGreen: "#86b300",
      brightYellow: "#eba400",
      brightBlue: "#22a4e6",
      brightMagenta: "#a37acc",
      brightCyan: "#4cbf99",
      brightWhite: "#c5c5c8",
    },
    thinking: {
      off: "#adaeb1",
      minimal: "#22a4e6",
      low: "#4cbf99",
      medium: "#eba400",
      high: "#a37acc",
      xhigh: "#fa8532",
      max: "#f07171",
    },
  },
  "catppuccin-frappe": {
    // catppuccin/palette, frappe ansiColors
    light: false,
    ansi: {
      black: "#51576d",
      red: "#e78284",
      green: "#a6d189",
      yellow: "#e5c890",
      blue: "#8caaee",
      magenta: "#f4b8e4",
      cyan: "#81c8be",
      white: "#a5adce",
      brightBlack: "#626880",
      brightRed: "#e67172",
      brightGreen: "#8ec772",
      brightYellow: "#d9ba73",
      brightBlue: "#7b9ef0",
      brightMagenta: "#f2a4db",
      brightCyan: "#5abfb5",
      brightWhite: "#b5bfe2",
    },
    thinking: {
      off: "#737994",
      minimal: "#8caaee",
      low: "#99d1db",
      medium: "#e5c890",
      high: "#ca9ee6",
      xhigh: "#ef9f76",
      max: "#e78284",
    },
  },
  "catppuccin-latte": {
    // catppuccin/palette, latte ansiColors
    light: true,
    ansi: {
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#de293e",
      brightGreen: "#49af3d",
      brightYellow: "#eea02d",
      brightBlue: "#456eff",
      brightMagenta: "#fe85d8",
      brightCyan: "#2d9fa8",
      brightWhite: "#bcc0cc",
    },
    thinking: {
      off: "#9ca0b0",
      minimal: "#1e66f5",
      low: "#04a5e5",
      medium: "#df8e1d",
      high: "#8839ef",
      xhigh: "#fe640b",
      max: "#d20f39",
    },
  },
  "catppuccin-macchiato": {
    // catppuccin/palette, macchiato ansiColors
    light: false,
    ansi: {
      black: "#494d64",
      red: "#ed8796",
      green: "#a6da95",
      yellow: "#eed49f",
      blue: "#8aadf4",
      magenta: "#f5bde6",
      cyan: "#8bd5ca",
      white: "#a5adcb",
      brightBlack: "#5b6078",
      brightRed: "#ec7486",
      brightGreen: "#8ccf7f",
      brightYellow: "#e1c682",
      brightBlue: "#78a1f6",
      brightMagenta: "#f2a9dd",
      brightCyan: "#63cbc0",
      brightWhite: "#b8c0e0",
    },
    thinking: {
      off: "#6e738d",
      minimal: "#8aadf4",
      low: "#91d7e3",
      medium: "#eed49f",
      high: "#c6a0f6",
      xhigh: "#f5a97f",
      max: "#ed8796",
    },
  },
  "catppuccin-mocha": {
    // catppuccin/palette, mocha ansiColors
    light: false,
    ansi: {
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#a6adc8",
      brightBlack: "#585b70",
      brightRed: "#f37799",
      brightGreen: "#89d88b",
      brightYellow: "#ebd391",
      brightBlue: "#74a8fc",
      brightMagenta: "#f2aede",
      brightCyan: "#6bd7ca",
      brightWhite: "#bac2de",
    },
    thinking: {
      off: "#6c7086",
      minimal: "#89b4fa",
      low: "#89dceb",
      medium: "#f9e2af",
      high: "#cba6f7",
      xhigh: "#fab387",
      max: "#f38ba8",
    },
  },
  "github-dark": {
    // primer/primitives, dark.json ansi
    light: false,
    ansi: {
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    },
    thinking: {
      off: "#6e7681",
      minimal: "#58a6ff",
      low: "#39c5cf",
      medium: "#d29922",
      high: "#bc8cff",
      xhigh: "#f0883e",
      max: "#ff7b72",
    },
  },
  "github-light": {
    // primer/primitives, light.json ansi
    light: true,
    ansi: {
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
    thinking: {
      off: "#8c959f",
      minimal: "#0969da",
      low: "#1b7c83",
      medium: "#9a6700",
      high: "#8250df",
      xhigh: "#bc4c00",
      max: "#cf222e",
    },
  },
  "tokyo-night": {
    // tokyonight.nvim, alacritty/tokyonight_night
    light: false,
    ansi: {
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#ff899d",
      brightGreen: "#9fe044",
      brightYellow: "#faba4a",
      brightBlue: "#8db0ff",
      brightMagenta: "#c7a9ff",
      brightCyan: "#a4daff",
      brightWhite: "#c0caf5",
    },
    thinking: {
      off: "#565f89",
      minimal: "#7aa2f7",
      low: "#7dcfff",
      medium: "#e0af68",
      high: "#bb9af7",
      xhigh: "#ff9e64",
      max: "#f7768e",
    },
  },
  "tokyo-night-day": {
    // tokyonight.nvim, alacritty/tokyonight_day
    light: true,
    ansi: {
      black: "#b4b5b9",
      red: "#f52a65",
      green: "#587539",
      yellow: "#8c6c3e",
      blue: "#2e7de9",
      magenta: "#9854f1",
      cyan: "#007197",
      white: "#6172b0",
      brightBlack: "#a1a6c5",
      brightRed: "#ff4774",
      brightGreen: "#5c8524",
      brightYellow: "#a27629",
      brightBlue: "#358aff",
      brightMagenta: "#a463ff",
      brightCyan: "#007ea8",
      brightWhite: "#3760bf",
    },
    thinking: {
      off: "#848cb5",
      minimal: "#2e7de9",
      low: "#007197",
      medium: "#8c6c3e",
      high: "#9854f1",
      xhigh: "#b15c00",
      max: "#f52a65",
    },
  },
  "tokyo-night-moon": {
    // tokyonight.nvim, alacritty/tokyonight_moon
    light: false,
    ansi: {
      black: "#1b1d2b",
      red: "#ff757f",
      green: "#c3e88d",
      yellow: "#ffc777",
      blue: "#82aaff",
      magenta: "#c099ff",
      cyan: "#86e1fc",
      white: "#828bb8",
      brightBlack: "#444a73",
      brightRed: "#ff8d94",
      brightGreen: "#c7fb6d",
      brightYellow: "#ffd8ab",
      brightBlue: "#9ab8ff",
      brightMagenta: "#caabff",
      brightCyan: "#b2ebff",
      brightWhite: "#c8d3f5",
    },
    thinking: {
      off: "#636da6",
      minimal: "#82aaff",
      low: "#86e1fc",
      medium: "#ffc777",
      high: "#c099ff",
      xhigh: "#ff966c",
      max: "#ff757f",
    },
  },
  "tokyo-night-storm": {
    // tokyonight.nvim, alacritty/tokyonight_storm
    light: false,
    ansi: {
      black: "#1d202f",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#ff899d",
      brightGreen: "#9fe044",
      brightYellow: "#faba4a",
      brightBlue: "#8db0ff",
      brightMagenta: "#c7a9ff",
      brightCyan: "#a4daff",
      brightWhite: "#c0caf5",
    },
    thinking: {
      off: "#565f89",
      minimal: "#7aa2f7",
      low: "#7dcfff",
      medium: "#e0af68",
      high: "#bb9af7",
      xhigh: "#ff9e64",
      max: "#f7768e",
    },
  },
} as const satisfies Record<string, ColorScheme>;

export type SchemeName = keyof typeof SCHEMES;

export const COLOR_SCHEMES: Record<SchemeName, ColorScheme> = SCHEMES;

/** Sorted, so a picker walking them lists them the same way every time. */
export const SCHEME_NAMES = Object.keys(SCHEMES).sort() as readonly SchemeName[];

/**
 * Inherit. Named colors and pi: tokens behave exactly as they did before any
 * scheme existed, no truecolor is emitted, and it stays correct if Pi's theme
 * changes later. It is the shipped value and the way back out of a scheme.
 */
export const DEFAULT_SCHEME = "default";

export type ColorSchemeName = SchemeName | typeof DEFAULT_SCHEME;

/**
 * Undefined for a name this build does not know, which the config turns into
 * "default" rather than a failed load, the same way an unknown preset and an
 * unknown separator already do.
 */
export function normalizeColorSchemeName(value: unknown): ColorSchemeName | undefined {
  if (typeof value !== "string") return undefined;
  if (value === DEFAULT_SCHEME) return DEFAULT_SCHEME;
  return Object.hasOwn(SCHEMES, value) ? (value as SchemeName) : undefined;
}

/** Undefined at "default", which is what tells the color layer to inherit. */
export function activeScheme(name: ColorSchemeName): ColorScheme | undefined {
  return name === DEFAULT_SCHEME ? undefined : COLOR_SCHEMES[name];
}
