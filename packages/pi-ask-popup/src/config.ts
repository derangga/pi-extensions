import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

/** Filename both layers use, under the agent dir and under the project's config dir. */
export const CONFIG_FILE_NAME = "pi-ask-popup.json";

/** Operator-supplied copy folded into the tool's registered description and prompt. */
export interface GuidanceFields {
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface AskPopupConfig {
  /**
   * Key spec for the collapse/expand shortcut, in pi-coding-agent keybinding id
   * format (`modifier+key`: `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults to
   * `"ctrl+]"`. Pick something reachable on your layout — Latin American
   * keyboards put `]` on the shifted layer and usually want `"ctrl+}"`. Pass
   * `"off"` to disable the shortcut entirely.
   */
  collapseKey?: CollapseKeySpec;
  guidance?: GuidanceFields;
}

export interface ConfigLoadResult {
  config: AskPopupConfig;
  /**
   * Problems worth telling the user about, as data. Never printed here: on RPC
   * and JSON hosts this process is speaking a protocol on stdout, and a stray
   * `console.warn` corrupts the stream. The caller decides where these go.
   */
  warnings: readonly string[];
}

export interface ConfigSources {
  /** Pi's global agent directory, normally `getAgentDir()` (`~/.pi/agent`). */
  agentDir: string;
  /**
   * Workspace root whose `<CONFIG_DIR_NAME>/pi-ask-popup.json` overrides the
   * global layer. Omit it to skip the project layer entirely — callers pass
   * `ctx.cwd` only when `ctx.isProjectTrusted()`, so an untrusted checkout
   * cannot rebind a global keyboard shortcut or rewrite the tool description
   * the model is given.
   */
  projectDir?: string;
}

/** The layer files, global first. Existence is not checked; reading never creates them. */
export function configPaths(sources: ConfigSources): string[] {
  const paths = [join(sources.agentDir, CONFIG_FILE_NAME)];
  if (sources.projectDir !== undefined) {
    paths.push(join(sources.projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
  }
  return paths;
}

/**
 * Read one layer. An absent file means "no overrides" and is not a warning —
 * having no config is the normal case, not a degraded one. Anything else that
 * goes wrong (malformed JSON, a directory in the file's place, no read
 * permission) degrades to no overrides and reports why.
 *
 * Deliberately `readFileSync` + catch rather than `existsSync` then read: the
 * check-then-read pair races, and this keeps the no-write guarantee obvious —
 * nothing here can create a file or a parent directory.
 */
function readLayer(path: string, warnings: string[]): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`pi-ask-popup: cannot read ${path} — ${(err as Error).message}`);
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    // `typeof null === "object"` and so is an array; a config file is neither.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`pi-ask-popup: ${path} is not a JSON object, ignoring it`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warnings.push(`pi-ask-popup: invalid JSON in ${path}, ignoring it — ${(err as Error).message}`);
    return {};
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Keep only the guidance entries that are usable, silently. A single bad field
 * is not worth a warning — the field falls back to the built-in default and
 * the tool still registers.
 */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
  if (fields === null || typeof fields !== "object") return {};
  const g = fields as Record<string, unknown>;
  const out: GuidanceFields = {};
  const description = nonEmptyString(g.description);
  if (description !== undefined) out.description = description;
  const promptSnippet = nonEmptyString(g.promptSnippet);
  if (promptSnippet !== undefined) out.promptSnippet = promptSnippet;
  const guidelines = g.promptGuidelines;
  if (
    Array.isArray(guidelines) &&
    guidelines.length > 0 &&
    guidelines.every((s) => nonEmptyString(s) !== undefined)
  ) {
    out.promptGuidelines = guidelines as string[];
  }
  return out;
}

/**
 * Read the global layer, then let the project layer override it. Guidance
 * merges per field rather than wholesale, so a workspace can pin one line of
 * copy without restating the rest.
 */
export function loadConfig(sources: ConfigSources): ConfigLoadResult {
  const warnings: string[] = [];
  const config: AskPopupConfig = {};
  for (const path of configPaths(sources)) {
    const raw = readLayer(path, warnings);
    const collapseKey = nonEmptyString(raw.collapseKey);
    if (collapseKey !== undefined) config.collapseKey = collapseKey;
    const guidance = validateGuidanceFields(raw.guidance);
    if (Object.keys(guidance).length > 0) {
      config.guidance = { ...config.guidance, ...guidance };
    }
  }
  return { config, warnings };
}

/**
 * Base keys pi-tui's `matchesKey` actually recognizes, transcribed from its
 * `SYMBOL_KEYS` set and the named cases of its match switch. Two deliberate
 * differences from the set upstream accepted:
 *
 * - `"` is gone. pi-tui does not carry it, so `ctrl+"` parsed fine and then
 *   matched nothing: a dead shortcut with no fallback and no diagnostic.
 * - `+` is gone. It is the separator, so no spec can name it as a base key
 *   anyway, and `matchesKey("+", "+")` is false.
 *
 * Named keys are lowercase because `parseKeyId` lowercases the whole id before
 * matching — `pageUp` reaches the switch as `pageup`.
 */
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_|~{}:<>?");
const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isBaseKey(key: string): boolean {
  if (key.length !== 1) return SPECIAL_KEYS.has(key);
  return (key >= "a" && key <= "z") || (key >= "0" && key <= "9") || SYMBOL_KEYS.has(key);
}

/**
 * Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then
 * one base key.
 *
 * Loose acceptance is not merely untidy here. pi-tui's `parseKeyId` takes the
 * LAST `+`-part as the key and asks only whether the remaining parts *include*
 * "ctrl"/"shift"/"alt"/"super" — unknown parts are discarded, not rejected. So
 * a typo like `ctr+]` parses as a bare `]` with no modifiers, and the raw
 * terminal listener that owns this shortcut would then swallow every `]` the
 * user types, anywhere.
 */
function isValidCollapseKeySpec(spec: string): boolean {
  if (!spec || spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
  const parts = spec.split("+");
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size) return false;
  if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
  return isBaseKey(base);
}

/**
 * Normalize and validate the configured shortcut, falling back to the default.
 *
 * The parameter widens `collapseKey` to include an explicit `undefined` rather
 * than leaving it merely optional: callers spread a partially-populated config
 * in, and under `exactOptionalPropertyTypes` a present-but-undefined key is a
 * different type from an absent one. Both mean "not configured" here.
 */
export function resolveCollapseKey(config: {
  collapseKey?: CollapseKeySpec | undefined;
}): CollapseKeySpec {
  const raw = config.collapseKey?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
  if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
  return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// The only compound-word names in SPECIAL_KEYS — capitalizing the first letter
// alone would render them "Pageup" and "Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * Pretty-print a resolved spec for UI copy: `"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` →
 * `"Alt+O"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`. Display only — matching
 * always uses the raw lowercase spec, so never feed the result back into
 * `matchesKey`.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
  return spec
    .split("+")
    .map(
      (part) =>
        COMPOUND_KEY_DISPLAY[part] ??
        (part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
    )
    .join("+");
}
