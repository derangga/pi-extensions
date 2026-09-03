import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { normalizeColor } from "./colors.js";
import { PRESET_DEFINITIONS, type Preset, type PresetWidget } from "./presets.js";
import { SEPARATOR_VALUES, type SeparatorStyle } from "./separators.js";
import type { IconMode, StatusbarConfig, StatusbarSettings, WidgetEntry } from "./types.js";
import { ICON_MODE_VALUES, isRecord } from "./types.js";
import { registry, type WidgetType } from "./widgets/registry.js";

export const STATUS_KEY = "pi-statusbar";

const CONFIG_ENV = "PI_STATUSBAR_CONFIG";
const SEPARATORS = new Set<SeparatorStyle>(SEPARATOR_VALUES);

export const DEFAULT_CONFIG: StatusbarConfig = {
  version: 1,
  enabled: true,
  preset: "default",
  lines: linesForPreset("default"),
  separator: PRESET_DEFINITIONS.default.separator,
  separatorFg: "default",
  separatorBg: "default",
  iconMode: "emoji",
};

export function getConfigPath(): string {
  return process.env[CONFIG_ENV] ?? join(getAgentDir(), "extensions", "pi-statusbar.json");
}

function linesForPreset(preset: Preset): WidgetEntry[][] {
  return PRESET_DEFINITIONS[preset].lines.map((line) => widgetsFromPresetLine(line));
}

function widgetsFromPresetLine(line: readonly PresetWidget[]): WidgetEntry[] {
  return line.map((widget) => registry.createEntry(widget.type, widget.options));
}

/**
 * Switches layout without touching the icon mode. An explicit icon choice is a
 * statement about the terminal's font, so a preset must not overwrite it.
 */
export function configWithPreset(config: StatusbarConfig, preset: Preset): StatusbarConfig {
  return {
    ...config,
    preset,
    lines: linesForPreset(preset),
    separator: PRESET_DEFINITIONS[preset].separator,
  };
}

export function normalizeConfig(input: unknown): StatusbarConfig {
  if (!isRecord(input)) return cloneConfig(DEFAULT_CONFIG);

  const preset = isPreset(input.preset) ? input.preset : DEFAULT_CONFIG.preset;

  return {
    version: 1,
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled,
    preset,
    lines: normalizeLines(input.lines, preset),
    separator: isSeparatorStyle(input.separator)
      ? input.separator
      : PRESET_DEFINITIONS[preset].separator,
    separatorFg: normalizeColor(input.separatorFg) ?? DEFAULT_CONFIG.separatorFg,
    separatorBg: normalizeColor(input.separatorBg) ?? DEFAULT_CONFIG.separatorBg,
    iconMode: isIconMode(input.iconMode) ? input.iconMode : DEFAULT_CONFIG.iconMode,
  };
}

export function cloneSettings(settings: StatusbarSettings): StatusbarSettings {
  return { ...settings };
}

export function cloneConfig(config: StatusbarConfig): StatusbarConfig {
  return {
    ...cloneSettings(config),
    lines: config.lines.map((line) =>
      line.map((widget) => ({ ...widget, options: { ...widget.options } })),
    ),
  };
}

export interface LoadedConfig {
  config: StatusbarConfig;
  /** Set when the file existed but could not be used. The caller reports it once. */
  error?: string;
}

/**
 * A missing file is the normal first run. A file that exists but cannot be
 * parsed falls back to defaults and reports why, rather than throwing: pi-footer
 * rethrows anything that is not ENOENT, which stops the extension loading and
 * takes the footer with it. A statusline is not worth a failed load.
 */
export async function loadConfig(path = getConfigPath()): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return { config: cloneConfig(DEFAULT_CONFIG) };
    return {
      config: cloneConfig(DEFAULT_CONFIG),
      error: `could not read ${path}: ${messageFor(error)}`,
    };
  }

  try {
    return { config: normalizeConfig(JSON.parse(raw)) };
  } catch (error) {
    return {
      config: cloneConfig(DEFAULT_CONFIG),
      error: `${path} is not valid JSON, using defaults: ${messageFor(error)}`,
    };
  }
}

export async function saveConfig(config: StatusbarConfig, path = getConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
}

function normalizeLines(linesValue: unknown, preset: Preset): WidgetEntry[][] {
  if (!Array.isArray(linesValue)) return linesForPreset(preset);
  return linesValue.map((line) => normalizeWidgets(line));
}

function normalizeWidgets(value: unknown): WidgetEntry[] {
  if (!Array.isArray(value)) return [];

  const widgets: WidgetEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    const spec = registry.maybeSpec(item.type);
    // A type this build does not know is dropped rather than defaulted. Keeping
    // it would put an unrenderable entry in front of the renderer.
    if (!spec) continue;
    const type = spec.type as WidgetType;
    widgets.push({
      id:
        typeof item.id === "string" && item.id.length > 0 ? item.id : registry.createEntry(type).id,
      type,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      options: registry.normalizeOptions(type, isRecord(item.options) ? item.options : {}),
    });
  }

  return widgets;
}

export function isPreset(value: unknown): value is Preset {
  return typeof value === "string" && Object.hasOwn(PRESET_DEFINITIONS, value);
}

function isSeparatorStyle(value: unknown): value is SeparatorStyle {
  return typeof value === "string" && SEPARATORS.has(value as SeparatorStyle);
}

function isIconMode(value: unknown): value is IconMode {
  return typeof value === "string" && ICON_MODE_VALUES.includes(value as IconMode);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
