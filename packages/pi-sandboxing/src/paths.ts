/**
 * Path arithmetic. Nothing here imports Pi, so every decision this extension
 * makes about a path is testable without a host.
 *
 * Copied from `pi-dir-permission/src/boundary.ts` rather than shared: both
 * packages publish independently with no dependencies, and forty lines of
 * duplication is cheaper than a package to hold them.
 *
 * Every comparison runs on resolved, symlink-followed absolute paths. macOS
 * hands out `/var/folders/...` temp directories that are symlinks into
 * `/private/var`, and a symlink inside the workspace can point anywhere;
 * comparing paths as they were typed would let both walk straight through.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Match Pi's conversion of Git Bash, MSYS, Cygwin, and WSL drive paths. */
export function normalizeToolPath(input: string, platform = process.platform): string {
  if (
    platform !== "win32" ||
    !input.startsWith("/") ||
    input.startsWith("//") ||
    input.includes("\\")
  ) {
    return input;
  }
  const match = input.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (match === null) {
    return input;
  }
  const drive = match[1];
  if (drive === undefined) {
    return input;
  }
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

/** `~` and `~/x` expand against `home`. Anything else is returned untouched. */
export function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(home, input.slice(2));
  }
  return input;
}

/**
 * Resolve the deepest existing ancestor and re-attach the rest. `write` names
 * a file that does not exist yet, so bailing out on the first ENOENT would
 * leave a symlinked prefix uncompared, which is the one case worth getting
 * right.
 */
function realpathOrNearest(target: string): string {
  const suffix: string[] = [];
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    }
    const parent = dirname(current);
    if (parent === current) {
      return target;
    }
    suffix.unshift(basename(current));
    current = parent;
  }
}

/** Absolute and `~`-expanded, without following symlinks. */
export function resolveLexical(input: string, cwd: string, home: string): string {
  return resolve(cwd, expandHome(input, home));
}

/** Absolute, `~`-expanded, symlink-followed. Relative input resolves against `cwd`. */
export function resolveCandidate(input: string, cwd: string, home: string): string {
  return realpathOrNearest(resolveLexical(input, cwd, home));
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

/** False for a missing path, a file, or anything that cannot be stat'd. */
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
