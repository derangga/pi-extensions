/**
 * `pi-sandboxing.json`, read from Pi's agent directory and then from the
 * workspace's own config directory.
 *
 * Reading never creates a file, and a malformed one degrades to defaults with a
 * warning rather than taking the session down: a session that cannot start is
 * worse than one rule that was dropped.
 *
 * `unguard` is global-only. A workspace that could shrink its own protection
 * would make strict mode meaningless. The old `enabled` switch is rejected;
 * unrestricted shell access is a visible, session-only choice in the UI.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonArray, isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.js";
import type { RuleLayer } from "./rules.js";

export const CONFIG_FILE_NAME = "pi-sandboxing.json";

export interface SandboxingConfig {
  /** Compatibility field. Strict mode always starts enabled. */
  enabled: true;
  global: { rules: string[]; unguard: string[] };
  /** Additions only; `unguard` is dropped at parse time. */
  project: { rules: string[]; unguard: string[] };
  /** Lowercased, so matching can ignore case. */
  stoplist: Set<string>;
  gatedTools: Map<string, string>;
}

export interface ConfigLoadResult {
  config: SandboxingConfig;
  /** False means strict shell execution must fail closed. */
  valid: boolean;
  /**
   * Problems worth telling the user about, as data. Never printed here: on RPC
   * and JSON hosts this process speaks a protocol on stdout, and a stray
   * `console.warn` corrupts the stream.
   */
  warnings: string[];
}

/** One config file as it arrives: a JSON object whose fields are still unparsed. */
type RawLayer = { [key: string]: JsonValue };

/** Strings only. Invalid entries are dropped and make the configuration invalid. */
function stringList(
  value: JsonValue | undefined,
  key: string,
  source: string,
  warnings: string[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isJsonArray(value)) {
    warnings.push(`${source}: "${key}" must be an array of strings; ignoring it.`);
    return [];
  }
  const strings = value.filter(isJsonString);
  if (strings.length !== value.length) {
    warnings.push(`${source}: "${key}" contains a non-string entry; ignoring that entry.`);
  }
  return strings;
}

function toolMap(
  value: JsonValue | undefined,
  source: string,
  warnings: string[],
): ReadonlyMap<string, string> {
  if (value === undefined) {
    return new Map();
  }
  if (!isJsonObject(value)) {
    warnings.push(`${source}: "gatedTools" must be an object; ignoring it.`);
    return new Map();
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    isJsonString(entry[1]),
  );
  if (entries.length !== Object.keys(value).length) {
    warnings.push(`${source}: "gatedTools" contains a non-string value; ignoring that entry.`);
  }
  return new Map(entries);
}

function mergeToolMaps(
  globalTools: ReadonlyMap<string, string>,
  projectTools: ReadonlyMap<string, string>,
): Map<string, string> {
  const merged = new Map(globalTools);
  for (const [name, argument] of projectTools) {
    if (!merged.has(name)) {
      merged.set(name, argument);
    }
  }
  return merged;
}

interface ReadLayerResult {
  layer: RawLayer;
  valid: boolean;
}

function readLayer(directory: string | undefined, warnings: string[]): ReadLayerResult {
  if (directory === undefined) {
    return { layer: {}, valid: true };
  }
  const path = join(directory, CONFIG_FILE_NAME);
  if (!existsSync(path)) {
    return { layer: {}, valid: true };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    warnings.push(`${CONFIG_FILE_NAME} in ${directory} cannot be read.`);
    return { layer: {}, valid: false };
  }
  const parsed = parseJson(text);
  if (parsed === undefined) {
    warnings.push(`${CONFIG_FILE_NAME} in ${directory} is not valid JSON; using defaults.`);
    return { layer: {}, valid: false };
  }
  if (!isJsonObject(parsed)) {
    warnings.push(`${CONFIG_FILE_NAME} in ${directory} must contain an object; using defaults.`);
    return { layer: {}, valid: false };
  }
  return { layer: parsed, valid: true };
}

/**
 * Both layers, parsed. `projectDir` is undefined for an untrusted checkout,
 * which drops that layer entirely rather than reading it and filtering later.
 */
export function loadConfig(agentDir: string, projectDir: string | undefined): ConfigLoadResult {
  const warnings: string[] = [];
  const globalResult = readLayer(agentDir, warnings);
  const projectResult = readLayer(projectDir, warnings);
  const globalLayer = globalResult.layer;
  const projectLayer = projectResult.layer;

  if (globalLayer.enabled !== undefined || projectLayer.enabled !== undefined) {
    warnings.push(`${CONFIG_FILE_NAME}: "enabled" is obsolete; strict mode always starts enabled.`);
  }
  if (projectLayer.unguard !== undefined) {
    warnings.push(
      `${CONFIG_FILE_NAME} in the workspace cannot set "unguard"; those rules stay in force.`,
    );
  }

  const validationWarningStart = warnings.length;
  const globalName = `${CONFIG_FILE_NAME} in ${agentDir}`;
  const projectName = `${CONFIG_FILE_NAME} in the workspace`;
  const stoplist = [
    ...stringList(globalLayer.stoplist, "stoplist", globalName, warnings),
    ...stringList(projectLayer.stoplist, "stoplist", projectName, warnings),
  ].map((word) => word.toLowerCase());

  return {
    config: {
      enabled: true,
      global: {
        rules: stringList(globalLayer.rules, "rules", globalName, warnings),
        unguard: stringList(globalLayer.unguard, "unguard", globalName, warnings),
      },
      project: {
        rules: stringList(projectLayer.rules, "rules", projectName, warnings),
        unguard: [],
      },
      stoplist: new Set(stoplist),
      gatedTools: mergeToolMaps(
        toolMap(globalLayer.gatedTools, globalName, warnings),
        toolMap(projectLayer.gatedTools, projectName, warnings),
      ),
    },
    valid: globalResult.valid && projectResult.valid && warnings.length === validationWarningStart,
    warnings,
  };
}

export interface RuleLayers {
  global: RuleLayer;
  project: RuleLayer;
}

/** The two layers as `mergeLayers` wants them. */
export function ruleLayers(config: SandboxingConfig): RuleLayers {
  return { global: config.global, project: config.project };
}
