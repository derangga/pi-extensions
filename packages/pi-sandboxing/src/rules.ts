/**
 * The deny list, and what a path has to look like to match one.
 *
 * Nothing here imports Pi. A rule is one glob plus the layer it came from, and
 * every question the extension asks about a path is answered by these
 * functions, so the whole policy is testable without a host.
 */
import { basename, isAbsolute, parse, resolve, sep } from "node:path";
import { expandHome, isInside } from "./paths.js";

/** Where a rule came from. Only the global layer may remove a builtin. */
export type RuleSource = "builtin" | "global" | "project";

export interface Rule {
  glob: string;
  source: RuleSource;
}

/** One config file's contribution, still unvalidated when it arrives. */
export interface RuleLayer {
  rules?: readonly string[];
  unguard?: readonly string[];
}

/**
 * The credential files the README promises. Order matters: the first match
 * wins, so the exact `.env` is listed before the `.env.*` wildcard that would
 * otherwise claim it and report a vaguer glob back to the user.
 */
export const BUILTIN_RULES: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "credentials.json",
  "service-account*.json",
  ".npmrc",
  ".netrc",
  "~/.aws/",
  "~/.ssh/",
  "~/.gnupg/",
  "~/.cargo/credentials*",
  "~/.docker/",
  "~/.kube/",
  "~/.config/gcloud/",
  "~/.config/gh/",
  "~/.azure/",
];

/**
 * Committed files full of fake values. Harvesting one turns `changeme` into a
 * needle that redacts half the session's output, and gating one costs a dialog
 * on a file that is already public.
 */
const EXAMPLE_SUFFIXES: readonly string[] = [".example", ".sample", ".template", ".dist"];

/**
 * Tool name to the argument that names a path.
 *
 * These built-ins resolve paths in-process, where no kernel profile reaches
 * them. `ls` is absent on purpose: a listing that shows `.env` exists leaks
 * nothing. The fff entries are `@ff-labs/pi-fff`, whose `path` argument accepts
 * absolute and `~/` paths searched through a separate index; it renames its
 * tools to `grep`, `find` and `multi_grep` in override mode, which the built-in
 * names already cover.
 */
const GATED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["read", "path"],
  ["edit", "path"],
  ["write", "path"],
  ["grep", "path"],
  ["find", "path"],
  ["ffgrep", "path"],
  ["fffind", "path"],
  ["fff-multi-grep", "path"],
]);

export interface LayerInput {
  global: RuleLayer;
  project: RuleLayer;
  /** An untrusted checkout's config is ignored outright, additions included. */
  projectTrusted: boolean;
}

/**
 * Builtin, then global, then project, deduplicated by glob with the first
 * occurrence kept. `unguard` is honoured from the global layer only: a
 * repository that could shrink its own deny list would be no deny list at all.
 */
export function mergeLayers({ global, project, projectTrusted }: LayerInput): Rule[] {
  const unguarded = new Set(global.unguard ?? []);
  const candidates: Rule[] = [
    ...BUILTIN_RULES.map((glob): Rule => ({ glob, source: "builtin" })),
    ...(global.rules ?? []).map((glob): Rule => ({ glob, source: "global" })),
    ...(projectTrusted ? (project.rules ?? []) : []).map((glob): Rule => ({
      glob,
      source: "project",
    })),
  ];

  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const rule of candidates) {
    if (unguarded.has(rule.glob) || seen.has(rule.glob)) {
      continue;
    }
    seen.add(rule.glob);
    rules.push(rule);
  }
  return rules;
}

/** A glob that names a location rather than a filename, so it resolves against a root. */
function isPathGlob(glob: string): boolean {
  return glob.includes("/") || glob.includes(sep);
}

function portable(path: string): string {
  return sep === "\\" ? path.replaceAll("\\", "/") : path;
}

function matchesPattern(value: string, glob: string): boolean {
  const memo = new Map<number, boolean>();
  const visit = (valueIndex: number, globIndex: number): boolean => {
    const key = globIndex * (value.length + 1) + valueIndex;
    const known = memo.get(key);
    if (known !== undefined) {
      return known;
    }
    let result: boolean;
    if (globIndex === glob.length) {
      result = valueIndex === value.length;
    } else if (glob.charAt(globIndex) === "*") {
      let nextGlobIndex = globIndex;
      while (glob.charAt(nextGlobIndex) === "*") {
        nextGlobIndex++;
      }
      const crossesSeparators = nextGlobIndex - globIndex > 1;
      result =
        visit(valueIndex, nextGlobIndex) ||
        (valueIndex < value.length &&
          (crossesSeparators || value.charAt(valueIndex) !== "/") &&
          visit(valueIndex + 1, globIndex));
    } else {
      result =
        valueIndex < value.length &&
        value.charAt(valueIndex) === glob.charAt(globIndex) &&
        visit(valueIndex + 1, globIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/** Match a native path against a `*`/`**` path pattern. */
export function matchesPathPattern(value: string, glob: string): boolean {
  return matchesPattern(portable(value), portable(glob));
}

/** The absolute form of a path glob, or undefined when the glob names a filename. */
function absoluteGlob(glob: string, cwd: string, home: string): string | undefined {
  if (!isPathGlob(glob)) {
    return undefined;
  }
  const expanded = expandHome(glob, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function matchesGlob(candidate: string, glob: string, cwd: string, home: string): boolean {
  const absolute = absoluteGlob(glob, cwd, home);
  if (absolute === undefined) {
    return matchesPattern(basename(candidate), glob);
  }
  // A trailing slash names a directory, and everything under it is covered.
  if (glob.endsWith("/") || glob.endsWith(sep)) {
    const directory = absolute.replace(/[\\/]+$/, "") || parse(absolute).root;
    return isInside(directory, candidate);
  }
  return matchesPathPattern(candidate, absolute);
}

/**
 * The first rule that claims `candidate`, which must already be resolved.
 * `undefined` is the common answer and means the call proceeds untouched.
 */
export function matchRule(
  candidate: string,
  rules: readonly Rule[],
  cwd: string,
  home: string,
): Rule | undefined {
  const example = EXAMPLE_SUFFIXES.some((suffix) => basename(candidate).endsWith(suffix));
  return rules.find(
    (rule) =>
      (!example || rule.source !== "builtin") && matchesGlob(candidate, rule.glob, cwd, home),
  );
}

/** The argument holding a path for one tool, or undefined when it is not gated. */
export function gatedArgument(
  toolName: string,
  extraTools: ReadonlyMap<string, string>,
): string | undefined {
  return GATED_TOOLS.get(toolName) ?? extraTools.get(toolName);
}
