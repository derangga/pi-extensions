/**
 * `pi-sandboxing.json`, read from Pi's agent directory and then from the
 * workspace's own config directory.
 *
 * Reading never creates a file, and a malformed one degrades to defaults with a
 * warning rather than taking the session down: a session that cannot start is
 * worse than one rule that was dropped.
 *
 * Two keys are global-only on purpose. `unguard` removes a builtin rule, and
 * `enabled` turns the extension off; if a workspace could set either, cloning a
 * repository would be enough to disable the sandbox.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isJsonArray,
  isJsonBoolean,
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonValue,
} from "./json.js";
import type { RuleLayer } from "./rules.js";

export const CONFIG_FILE_NAME = "pi-sandboxing.json";

export interface SandboxingConfig {
  /** From the global layer only. */
  enabled: boolean;
  global: { rules: string[]; unguard: string[] };
  /** Additions only; `unguard` is dropped at parse time. */
  project: { rules: string[]; unguard: string[] };
  /** Lowercased, so matching can ignore case. */
  stoplist: Set<string>;
  gatedTools: Map<string, string>;
}

export interface ConfigLoadResult {
  config: SandboxingConfig;
  /**
   * Problems worth telling the user about, as data. Never printed here: on RPC
   * and JSON hosts this process speaks a protocol on stdout, and a stray
   * `console.warn` corrupts the stream.
   */
  warnings: string[];
}

/** One config file as it arrives: a JSON object whose fields are still unparsed. */
type RawLayer = { [key: string]: JsonValue };

/** A boolean, or the fallback for a missing or wrongly-typed key. */
function booleanOr(value: JsonValue | undefined, fallback: boolean): boolean {
  return value !== undefined && isJsonBoolean(value) ? value : fallback;
}

/** Strings only. A stray number in the array is dropped, not fatal. */
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
  return value.filter(isJsonString);
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
  return new Map(entries);
}

function readLayer(directory: string | undefined, warnings: string[]): RawLayer {
  if (directory === undefined) {
    return {};
  }
  let text: string;
  try {
    text = readFileSync(join(directory, CONFIG_FILE_NAME), "utf8");
  } catch {
    return {};
  }
  const parsed = parseJson(text);
  if (parsed === undefined) {
    warnings.push(`${CONFIG_FILE_NAME} in ${directory} is not valid JSON; using defaults.`);
    return {};
  }
  if (!isJsonObject(parsed)) {
    warnings.push(`${CONFIG_FILE_NAME} in ${directory} must contain an object; using defaults.`);
    return {};
  }
  return parsed;
}

/**
 * Both layers, parsed. `projectDir` is undefined for an untrusted checkout,
 * which drops that layer entirely rather than reading it and filtering later.
 */
export function loadConfig(agentDir: string, projectDir: string | undefined): ConfigLoadResult {
  const warnings: string[] = [];
  const globalLayer = readLayer(agentDir, warnings);
  const projectLayer = readLayer(projectDir, warnings);

  if (globalLayer.enabled !== undefined && !isJsonBoolean(globalLayer.enabled)) {
    warnings.push(`${CONFIG_FILE_NAME}: "enabled" must be true or false; leaving it on.`);
  }
  if (projectLayer.enabled !== undefined) {
    warnings.push(
      `${CONFIG_FILE_NAME} in the workspace cannot set "enabled"; the sandbox stays on.`,
    );
  }
  if (projectLayer.unguard !== undefined) {
    warnings.push(
      `${CONFIG_FILE_NAME} in the workspace cannot set "unguard"; those rules stay in force.`,
    );
  }

  const globalName = `${CONFIG_FILE_NAME} in ${agentDir}`;
  const projectName = `${CONFIG_FILE_NAME} in the workspace`;
  const stoplist = [
    ...stringList(globalLayer.stoplist, "stoplist", globalName, warnings),
    ...stringList(projectLayer.stoplist, "stoplist", projectName, warnings),
  ].map((word) => word.toLowerCase());

  return {
    config: {
      enabled: booleanOr(globalLayer.enabled, true),
      global: {
        rules: stringList(globalLayer.rules, "rules", globalName, warnings),
        unguard: stringList(globalLayer.unguard, "unguard", globalName, warnings),
      },
      project: {
        rules: stringList(projectLayer.rules, "rules", projectName, warnings),
        unguard: [],
      },
      stoplist: new Set(stoplist),
      gatedTools: new Map([
        ...toolMap(globalLayer.gatedTools, globalName, warnings),
        ...toolMap(projectLayer.gatedTools, projectName, warnings),
      ]),
    },
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
