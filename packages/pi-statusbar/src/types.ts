import type { ColorName } from "./colors.js";
import type { Preset } from "./presets.js";
import type { ColorSchemeName } from "./schemes.js";
import type { SeparatorStyle } from "./separators.js";
import type { WidgetType } from "./widgets/registry.js";

export interface WidgetEntry {
  id: string;
  type: WidgetType;
  enabled: boolean;
  options: WidgetOptions;
}

type WidgetOptionValue = string | number | boolean | undefined;

/** Renderer-level style options, shared by every widget rather than declared per widget. */
export interface WidgetStyle {
  fg?: ColorName;
  bg?: ColorName;
  bold?: boolean;
}

export interface WidgetOptions extends WidgetStyle {
  [key: string]: WidgetOptionValue;

  // Base options. Anything widget-specific is declared through the spec's properties.
  icon?: string;
  raw?: boolean;
  hideWhenEmpty?: boolean;
  hideWhenZero?: boolean;
  text?: string;
}

export const ICON_MODE_VALUES = ["emoji", "nerd"] as const;

export type IconMode = (typeof ICON_MODE_VALUES)[number];

/**
 * Everything about the footer except which widgets are on which line. Kept
 * separate from the lines so the command can print and change settings without
 * touching a layout, and so the widget store can hold one without the other.
 */
export interface StatusbarSettings {
  version: 1;
  enabled: boolean;
  preset: Preset;
  separator: SeparatorStyle;
  separatorFg: ColorName;
  separatorBg: ColorName;
  iconMode: IconMode;
  colorScheme: ColorSchemeName;
}

export interface StatusbarConfig extends StatusbarSettings {
  lines: WidgetEntry[][];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Statuses other extensions publish through ctx.ui.setStatus, read live at render time. */
export type GetExtensionStatuses = () => ReadonlyMap<string, string>;

/**
 * Only what a shipped widget reads. pi-footer also accumulates input, output and
 * cache token counts, message counts by role, compactions and per-turn totals,
 * all of which fed widgets this package does not ship. Collecting them here
 * would mean collecting and testing numbers nothing displays.
 */
export interface SessionMetrics {
  costUsd: number;
  firstTimestampMs: number | undefined;
}

export interface GitInfo {
  branch: string | null;
  sha: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  insertions: number;
  deletions: number;
  ahead: number;
  behind: number;
  isRepo: boolean;
}

/**
 * The materialized snapshot a render pass reads. A widget declares which of
 * these keys it needs and receives only those, so a widget cannot quietly grow
 * a dependency on data nobody collected for it.
 */
export interface StatusbarData {
  model: string | undefined;
  provider: string | undefined;
  thinkingLevel: string | undefined;
  git: GitInfo;
  cwd: string;
  usingSubscription: boolean;
  contextTokens: number | undefined;
  contextMaxTokens: number | undefined;
  metrics: SessionMetrics;
}
