/**
 * The deny list, and what a path has to look like to match one.
 *
 * Nothing here imports Pi. A rule is one glob plus the layer it came from, and
 * every question the extension asks about a path is answered by these
 * functions, so the whole policy is testable without a host.
 */
import { basename } from "node:path";
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
 * The five built-ins Pi resolves in-process, where no kernel profile reaches
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
  return glob.includes("/");
}

function globToRegExp(glob: string): RegExp {
  // `**` crosses separators, a single `*` stays inside one segment. Everything
  // else is escaped, so a dot in `.env` is a dot and not any character.
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    // charAt rather than indexing: it returns "" past the end instead of
    // undefined, so the lookahead below needs no separate bounds check.
    const char = glob.charAt(index);
    if (char === "*") {
      if (glob.charAt(index + 1) === "*") {
        source += ".*";
        index++;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The absolute form of a path glob, or undefined when the glob names a filename. */
function absoluteGlob(glob: string, cwd: string, home: string): string | undefined {
  if (!isPathGlob(glob)) {
    return undefined;
  }
  const expanded = expandHome(glob, home);
  return expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
}

function matchesGlob(candidate: string, glob: string, cwd: string, home: string): boolean {
  const absolute = absoluteGlob(glob, cwd, home);
  if (absolute === undefined) {
    return globToRegExp(glob).test(basename(candidate));
  }
  // A trailing slash names a directory, and everything under it is covered.
  if (absolute.endsWith("/")) {
    return isInside(absolute.slice(0, -1), candidate);
  }
  return globToRegExp(absolute).test(candidate);
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
  const name = basename(candidate);
  if (EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return undefined;
  }
  return rules.find((rule) => matchesGlob(candidate, rule.glob, cwd, home));
}

/**
 * The rules a kernel profile can deny: the ones naming a location inside the
 * user's home directory. Repo-local rules are deliberately excluded, because
 * denying a project's own `.env` to the shell breaks every test suite that
 * loads it. The redactor covers those instead.
 *
 * A user who writes `~/projects/app/.env` as a rule gets it in the profile and
 * gets that project's dev loop jailed, which is what they asked for.
 */
export function homeRules(rules: readonly Rule[], home: string): Rule[] {
  return rules.filter((rule) => {
    const absolute = absoluteGlob(rule.glob, home, home);
    return absolute !== undefined && isInside(home, absolute.replace(/\/+$/, ""));
  });
}

/** The argument holding a path for one tool, or undefined when it is not gated. */
export function gatedArgument(
  toolName: string,
  extraTools: ReadonlyMap<string, string>,
): string | undefined {
  return extraTools.get(toolName) ?? GATED_TOOLS.get(toolName);
}
