import type { ColorName } from "./colors.js";
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Statuses other extensions publish through ctx.ui.setStatus, read live at render time. */
export type GetExtensionStatuses = () => ReadonlyMap<string, string>;

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  firstTimestampMs: number | undefined;
  lastTimestampMs: number | undefined;
}

export interface TurnMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
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
  turnMetrics: TurnMetrics;
}
