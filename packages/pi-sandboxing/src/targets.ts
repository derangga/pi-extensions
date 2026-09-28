import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import { expandHome, isInside } from "./paths.js";
import { matchRule, type Rule } from "./rules.js";

export interface ProtectedTarget {
  path: string;
  directory: boolean;
  /** The rule that protected this path or one of its file aliases. */
  rule?: Rule;
}

interface Entry {
  path: string;
  canonical: string;
  directory: boolean;
  identity: string | undefined;
  rule: Rule | undefined;
  alwaysMask: boolean;
}

interface EntryCache {
  entries: readonly Entry[];
  directories: ReadonlyMap<string, string>;
}

const entryCaches = new WeakMap<readonly Rule[], Map<string, EntryCache>>();

function filesystemErrorCode(error: Error): string | undefined {
  // SAFETY: Node filesystem APIs attach the optional string code defined by ErrnoException.
  return (error as NodeJS.ErrnoException).code;
}

function recoverableTraversalError(error: Error): boolean {
  const code = filesystemErrorCode(error);
  return code === "EACCES" || code === "ENOENT" || code === "EPERM";
}

function identity(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function followExistingSymlink(path: string, info: Stats): Stats | undefined {
  if (!info.isSymbolicLink()) {
    return info;
  }
  return existsSync(path) ? statSync(path) : undefined;
}

function directorySignature(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.mode}:${info.mtimeMs}:${info.ctimeMs}`;
}

function cacheIsCurrent(cache: EntryCache): boolean {
  for (const [path, signature] of cache.directories) {
    try {
      if (directorySignature(lstatSync(path)) !== signature) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function externalProtectedIdentities(
  workspace: string,
  rules: readonly Rule[],
  home: string,
): Map<string, Rule> {
  const found = new Map<string, Rule>();
  const walk = (path: string, rule: Rule): void => {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        walk(join(path, entry.name), rule);
      }
      return;
    }
    const fileIdentity = identity(path);
    if (fileIdentity !== undefined && !found.has(fileIdentity)) {
      found.set(fileIdentity, rule);
    }
  };
  for (const rule of rules) {
    const expanded = expandHome(rule.glob, home);
    if (!isAbsolute(expanded) || ["*", "?", "[", "{"].some((marker) => expanded.includes(marker))) {
      continue;
    }
    const path = expanded.replace(/[\\/]+$/, "") || parse(expanded).root;
    if (!existsSync(path) || isInside(workspace, canonical(path))) {
      continue;
    }
    walk(path, rule);
  }
  return found;
}

/**
 * Walk the whole workspace without following directory symlinks. A subtree
 * that disappears is skipped. An unreadable subtree is masked as a whole so a
 * command cannot make it readable after jail construction.
 */
function workspaceEntries(
  workspace: string,
  rules: readonly Rule[],
  home: string,
): readonly Entry[] {
  let caches = entryCaches.get(rules);
  if (caches === undefined) {
    caches = new Map();
    entryCaches.set(rules, caches);
  }
  const cacheKey = `${workspace}\0${home}`;
  const cached = caches.get(cacheKey);
  if (cached !== undefined && cacheIsCurrent(cached)) {
    return cached.entries;
  }

  const entries: Entry[] = [];
  const directories = new Map<string, string>();
  const walk = (directory: string, root: boolean): boolean => {
    try {
      directories.set(directory, directorySignature(lstatSync(directory)));
    } catch (error) {
      if (!root && error instanceof Error && recoverableTraversalError(error)) {
        return false;
      }
      throw error;
    }
    let dirents;
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (!root && error instanceof Error && recoverableTraversalError(error)) {
        return false;
      }
      throw error;
    }
    for (const dirent of dirents) {
      const path = join(directory, dirent.name);
      const lexicalRule = matchRule(path, rules, workspace, home);
      let info;
      try {
        info = lstatSync(path);
      } catch (error) {
        if (!(error instanceof Error) || !recoverableTraversalError(error)) {
          throw error;
        }
        if (filesystemErrorCode(error) !== "ENOENT") {
          entries.push({
            path,
            canonical: canonical(path),
            directory: dirent.isDirectory(),
            identity: undefined,
            rule: lexicalRule,
            alwaysMask: true,
          });
        }
        continue;
      }
      const target = canonical(path);
      const targetRule = matchRule(target, rules, workspace, home);
      const followed = followExistingSymlink(path, info);
      const directoryEntry = info.isDirectory();
      const entry: Entry = {
        path,
        canonical: target,
        directory: directoryEntry || followed?.isDirectory() === true,
        identity: identity(path),
        rule: lexicalRule ?? targetRule,
        alwaysMask: followed?.isSocket() === true,
      };
      entries.push(entry);
      if (directoryEntry && !walk(path, false)) {
        entry.alwaysMask = true;
      }
    }
    return true;
  };
  walk(workspace, true);
  caches.set(cacheKey, { entries, directories });
  return entries;
}

/** Existing non-glob absolute rule targets under roots visible to the jail. */
export function discoverExplicitTargets(
  rules: readonly Rule[],
  home: string,
  visibleRoots: readonly string[],
): ProtectedTarget[] {
  const targets = new Map<string, ProtectedTarget>();
  for (const rule of rules) {
    const expanded = expandHome(rule.glob, home);
    if (!isAbsolute(expanded) || ["*", "?", "[", "{"].some((marker) => expanded.includes(marker))) {
      continue;
    }
    const lexical = expanded.replace(/[\\/]+$/, "") || parse(expanded).root;
    if (!existsSync(lexical)) {
      continue;
    }
    const target = canonical(lexical);
    if (!visibleRoots.some((root) => isInside(root, lexical) || isInside(root, target))) {
      continue;
    }
    const directory = statSync(lexical).isDirectory();
    targets.set(lexical, { path: lexical, directory, rule });
    if (visibleRoots.some((root) => isInside(root, target))) {
      targets.set(target, { path: target, directory, rule });
    }
  }
  return [...targets.values()];
}

/**
 * Existing protected workspace paths plus every alias to the same file. The
 * canonical target is included so a protected symlink cannot be bypassed by
 * reading its destination under another name.
 */
export function discoverProtectedTargets(
  workspace: string,
  rules: readonly Rule[],
  home: string,
  includeExternalAliases = true,
): ProtectedTarget[] {
  const entries = workspaceEntries(workspace, rules, home);
  const protectedIdentities = includeExternalAliases
    ? externalProtectedIdentities(workspace, rules, home)
    : new Map<string, Rule>();
  for (const entry of entries) {
    if (entry.rule !== undefined && entry.identity !== undefined) {
      protectedIdentities.set(entry.identity, entry.rule);
    }
  }
  const targets = new Map<string, ProtectedTarget>();
  const add = (path: string, directory: boolean, rule: Rule | undefined): void => {
    const previous = targets.get(path);
    const target: ProtectedTarget = {
      path,
      directory: previous?.directory === true || directory,
    };
    const protectingRule = previous?.rule ?? rule;
    if (protectingRule !== undefined) {
      target.rule = protectingRule;
    }
    targets.set(path, target);
  };

  for (const entry of entries) {
    const rule =
      entry.rule ??
      (entry.identity === undefined ? undefined : protectedIdentities.get(entry.identity));
    if (rule === undefined && !entry.alwaysMask) {
      continue;
    }
    add(entry.path, entry.directory, rule);
    add(entry.canonical, entry.directory, rule);
  }
  return [...targets.values()].sort((left, right) => left.path.localeCompare(right.path));
}
