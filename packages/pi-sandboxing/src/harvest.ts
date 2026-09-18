/**
 * Reading secret values out of the files the rules name, so the redactor has
 * something exact to look for.
 *
 * Nothing here imports Pi. The walk only ever touches the workspace: a rule
 * pointing into the user's home directory is jailed by the profile and gated by
 * the dialog, and reading it to protect it would put every credential the user
 * owns into this process.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { matchRule, type Rule } from "./rules.js";

/** One harvested value, the label that replaces it, and the file it came from. */
export interface Needle {
  value: string;
  label: string;
  /** Workspace-relative path of the file this value was read from. */
  origin: string;
}

/** A config file is kilobytes. Anything past this is a payload that got the wrong name. */
const MAX_FILE_BYTES = 1024 * 1024;

/** A walk deep enough for any real repository, and a guard against a pathological tree. */
const MAX_DEPTH = 8;

/** Directories with nothing worth harvesting and enough entries to be worth skipping. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Shorter than this and a value is indistinguishable from a port or a flag. */
const MIN_VALUE_LENGTH = 8;

/**
 * The words that fill a dotenv file. Every one of them appears in ordinary
 * output constantly, so redacting them would make a session unreadable.
 */
const STOPLIST: ReadonlySet<string> = new Set([
  "true",
  "false",
  "yes",
  "no",
  "null",
  "none",
  "local",
  "localhost",
  "development",
  "production",
  "staging",
  "test",
  "debug",
  "postgres",
  "postgresql",
  "mysql",
  "sqlite",
  "redis",
  "mongodb",
  "utf8",
  "utf-8",
  "changeme",
  "password",
  "secret",
  "example",
]);

/** Is this value worth looking for, or would redacting it eat ordinary output? */
export function passesNoiseFloor(value: string, extraStoplist: ReadonlySet<string>): boolean {
  if (value.length < MIN_VALUE_LENGTH) {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return false;
  }
  const lowered = value.toLowerCase();
  return !STOPLIST.has(lowered) && !extraStoplist.has(lowered);
}

function unquote(value: string): string {
  const first = value.charAt(0);
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `KEY=value` lines, which covers dotenv and npmrc alike. The split takes the
 * first `=` only, so a base64 value keeps its padding.
 */
function extractKeyValues(content: string, file: string): Needle[] {
  const needles: Needle[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const value = unquote(line.slice(separator + 1).trim());
    if (value === "") {
      continue;
    }
    needles.push({ value, label: line.slice(0, separator).trim(), origin: file });
  }
  return needles;
}

/**
 * A parsed JSON document, named so the walk below branches on a domain type
 * rather than on `unknown`.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isJsonString(node: JsonValue): node is string {
  return typeof node === "string";
}

function isJsonObject(node: JsonValue): node is { [key: string]: JsonValue } {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

function parseJson(content: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse returns any; JsonValue is exactly the set of shapes it
    // can produce, and every branch below is guarded before use.
    return JSON.parse(content) as JsonValue;
  } catch {
    return undefined;
  }
}

function extractJsonLeaves(content: string, file: string): Needle[] | undefined {
  const parsed = parseJson(content);
  if (parsed === undefined) {
    return undefined;
  }
  const needles: Needle[] = [];
  const walk = (node: JsonValue, path: readonly string[]): void => {
    if (isJsonString(node)) {
      const label = `${file}:${path.join(".")}`;
      needles.push({ value: node, label, origin: file });
      // A service account's private_key is a whole PEM in one string. Keep the
      // string itself and its body lines, so truncated output still matches.
      if (node.includes("-----BEGIN ")) {
        needles.push(...extractPemBody(node, label, file));
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, [...path, String(index)]));
      return;
    }
    if (isJsonObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, [...path, key]);
      }
    }
  };
  walk(parsed, []);
  return needles;
}

const ARMOUR = /^-----(?:BEGIN|END) .*-----$/;

/**
 * Every body line, plus the body as one block. Pi truncates long output, so a
 * key that arrives cut in half still has to match line by line.
 */
function extractPemBody(content: string, label: string, file: string): Needle[] {
  const body = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !ARMOUR.test(line));
  if (body.length === 0) {
    return [];
  }
  const needles = body.map((line): Needle => ({ value: line, label, origin: file }));
  if (body.length > 1) {
    needles.push({ value: body.join("\n"), label, origin: file });
  }
  return needles;
}

/**
 * Per format, with keys named where the format has them. `file` is the label
 * root: a path relative to the workspace, so the placeholder says where the
 * value came from.
 */
export function extractNeedles(file: string, content: string): Needle[] {
  // Extension before content: a service account JSON holds a PEM inside
  // private_key, and treating the whole file as armour would produce one
  // useless needle spanning the entire document.
  if (basename(file).endsWith(".json")) {
    const leaves = extractJsonLeaves(content, file);
    if (leaves !== undefined) {
      return leaves;
    }
  }
  if (content.includes("-----BEGIN ")) {
    return extractPemBody(content, file, file);
  }
  return extractKeyValues(content, file);
}

/** Text, or nothing. A binary file with a key's name is a payload, not a config. */
function readTextFile(absolutePath: string): string | undefined {
  try {
    if (statSync(absolutePath).size > MAX_FILE_BYTES) {
      return undefined;
    }
    const buffer = readFileSync(absolutePath);
    if (buffer.includes(0)) {
      return undefined;
    }
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

/** One file's needles, as they are on disk right now. Empty for anything unreadable. */
export function harvestFile(
  absolutePath: string,
  cwd: string,
  extraStoplist: ReadonlySet<string>,
): Needle[] {
  const content = readTextFile(absolutePath);
  if (content === undefined) {
    return [];
  }
  return extractNeedles(relative(cwd, absolutePath), content).filter((needle) =>
    passesNoiseFloor(needle.value, extraStoplist),
  );
}

/** Rule-matching files inside the workspace. Symlinked directories are not followed. */
function collectFiles(cwd: string, rules: readonly Rule[], home: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          walk(full, depth + 1);
        }
        continue;
      }
      if (entry.isFile() && matchRule(full, rules, cwd, home) !== undefined) {
        found.push(full);
      }
    }
  };
  walk(cwd, 0);
  return found;
}

/** Every needle the workspace has to offer, at session start. */
export function harvest(
  cwd: string,
  rules: readonly Rule[],
  home: string,
  extraStoplist: ReadonlySet<string>,
): Needle[] {
  return collectFiles(cwd, rules, home).flatMap((file) => harvestFile(file, cwd, extraStoplist));
}
