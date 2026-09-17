/**
 * The path arithmetic behind the gate. Nothing here imports Pi, so every
 * decision the extension makes about a path is testable without a host.
 *
 * Every comparison runs on resolved, symlink-followed absolute paths. macOS
 * hands out `/var/folders/...` temp directories that are symlinks into
 * `/private/var`, and a symlink inside the workspace can point anywhere;
 * comparing paths as they were typed would let both walk straight through the
 * boundary.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** One directory the user has opened up for this session. */
export interface Grant {
  absolutePath: string;
  label: string;
}

/** The two directories a single grant can cover, as offered in the dialog. */
export interface GrantScopes {
  /** The directory the tool's path names, or its parent when the path is a file. */
  dir: string;
  /** The git repository `dir` sits in, when that is a wider and safe choice. */
  repoRoot: string | undefined;
}

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolve the deepest existing ancestor and re-attach the rest. `write` names
 * a file that does not exist yet and the picker resolves half-typed paths, so
 * bailing out on the first ENOENT would leave a symlinked prefix uncompared —
 * which is the one case worth getting right.
 */
function realpathOrNearest(target: string): string {
  const suffix: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return target;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/** Absolute, `~`-expanded, symlink-followed. Relative input resolves against `cwd`. */
export function resolveCandidate(input: string, cwd: string): string {
  return realpathOrNearest(resolve(cwd, expandHome(input)));
}

/**
 * Is `candidate` the directory `root` or something under it? Both must already
 * be resolved. String prefixes are not enough: `/a/bc` starts with `/a/b`
 * without being inside it.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function isAllowed(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isInside(root, candidate));
}

/**
 * What is inside the boundary before any grant: the workspace, the system temp
 * directory, and Pi's own agent directory. Refusing a scratch write to `/tmp`
 * or a read of the agent's own state buys no safety and costs a dialog every
 * session.
 */
export function baselineRoots(cwd: string, agentDir: string): readonly string[] {
  return [
    resolveCandidate(cwd, cwd),
    resolveCandidate(tmpdir(), cwd),
    resolveCandidate(agentDir, cwd),
  ];
}

/** False for a missing path, a file, or anything that cannot be stat'd. */
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasGitEntry(dir: string): boolean {
  try {
    // A worktree and a submodule keep a `.git` file rather than a directory.
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The repository `dir` belongs to, when offering it widens the grant usefully.
 * `$HOME` and the filesystem root are never offered: both are git repositories
 * on plenty of machines, and one stray file read must not be able to hand over
 * everything the user owns.
 */
function enclosingRepoRoot(dir: string, home: string): string | undefined {
  let current = dir;
  for (;;) {
    const parent = dirname(current);
    if (current === home || parent === current) {
      return undefined;
    }
    if (hasGitEntry(current)) {
      return current === dir ? undefined : current;
    }
    current = parent;
  }
}

/** The directories the block dialog can offer for a tool that wants `target`. */
export function grantScopes(target: string, home: string): GrantScopes {
  const dir = isDirectory(target) ? target : dirname(target);
  return { dir, repoRoot: enclosingRepoRoot(dir, home) };
}

/** Name shown in the status line and the manage list. */
export function grantLabel(absolutePath: string): string {
  return basename(absolutePath) || absolutePath;
}
