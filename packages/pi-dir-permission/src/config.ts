/**
 * `pi-dir-permission.json`, read from Pi's agent directory and then from the
 * workspace's own config directory, which overrides it. Reading never creates
 * a file, and a malformed one degrades to defaults with a warning rather than
 * taking the session down with it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Grant } from "./boundary.js";

export const CONFIG_FILE_NAME = "pi-dir-permission.json";

export type IconMode = "emoji" | "nerd";

/** U+F07B, nf-fa-folder. The oldest and most widely patched folder glyph. */
export const NERD_ICON = "\uf07b";
export const EMOJI_ICON = "\u{1f4c1}";

export interface DirPermissionConfig {
  iconMode: IconMode;
  /** Replaces the icon for either mode. Whatever the user's font actually has. */
  icon: string | undefined;
  /** Extra tool names to gate, mapped to the argument holding their path. */
  gatedTools: ReadonlyMap<string, string>;
}

export interface ConfigLoadResult {
  config: DirPermissionConfig;
  /**
   * Problems worth telling the user about, as data. Never printed here: on RPC
   * and JSON hosts this process speaks a protocol on stdout, and a stray
   * `console.warn` corrupts the stream.
   */
  warnings: readonly string[];
}

export const DEFAULT_CONFIG: DirPermissionConfig = {
  iconMode: "emoji",
  icon: undefined,
  gatedTools: new Map(),
};

/** One config file as it arrives: a JSON object whose fields are still unparsed. */
interface RawConfigLayer {
  iconMode?: unknown;
  icon?: unknown;
  gatedTools?: unknown;
}

function isRawConfigLayer(value: unknown): value is RawConfigLayer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIconMode(value: unknown): value is IconMode {
  return value === "emoji" || value === "nerd";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read one layer. An absent file is the normal case, not a degraded one, so it
 * is not a warning. Anything else that goes wrong — malformed JSON, a
 * directory in the file's place, no read permission — reports why and yields
 * nothing.
 */
function readLayer(path: string, warnings: string[]): RawConfigLayer | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRawConfigLayer(parsed)) {
      warnings.push(`${path}: expected a JSON object, ignoring it.`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function readGatedTools(
  layer: RawConfigLayer,
  path: string,
  warnings: string[],
): ReadonlyMap<string, string> | undefined {
  const value = layer.gatedTools;
  if (value === undefined) {
    return undefined;
  }
  if (!isRawConfigLayer(value)) {
    warnings.push(`${path}: gatedTools must be an object of tool name to argument name.`);
    return undefined;
  }
  const tools = new Map<string, string>();
  for (const [tool, field] of Object.entries(value)) {
    if (isNonEmptyString(field)) {
      tools.set(tool, field);
      continue;
    }
    warnings.push(`${path}: gatedTools.${tool} must name the argument holding the path.`);
  }
  return tools;
}

/**
 * Global layer first, workspace layer second. Callers pass the workspace's
 * config directory (`<cwd>/.pi`) only for a trusted project: an untrusted
 * checkout must not be able to widen its own boundary by naming a tool the
 * gate should stop watching.
 */
export function loadConfig(
  agentDir: string,
  projectConfigDir: string | undefined,
): ConfigLoadResult {
  const warnings: string[] = [];
  let config: DirPermissionConfig = DEFAULT_CONFIG;

  const paths = [join(agentDir, CONFIG_FILE_NAME)];
  if (projectConfigDir !== undefined) {
    paths.push(join(projectConfigDir, CONFIG_FILE_NAME));
  }

  for (const path of paths) {
    const layer = readLayer(path, warnings);
    if (layer === undefined) {
      continue;
    }
    config = {
      iconMode: isIconMode(layer.iconMode) ? layer.iconMode : config.iconMode,
      icon: isNonEmptyString(layer.icon) ? layer.icon : config.icon,
      gatedTools: readGatedTools(layer, path, warnings) ?? config.gatedTools,
    };
  }

  return { config, warnings };
}

export function icon(config: DirPermissionConfig): string {
  return config.icon ?? (config.iconMode === "nerd" ? NERD_ICON : EMOJI_ICON);
}

/** The footer line, or nothing at all while the boundary is just the workspace. */
export function statusText(
  grants: readonly Grant[],
  config: DirPermissionConfig,
): string | undefined {
  if (grants.length === 0) {
    return undefined;
  }
  return `${icon(config)} ${grants.length} external dir${grants.length === 1 ? "" : "s"}`;
}
