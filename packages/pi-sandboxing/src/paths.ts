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
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
export function resolveCandidate(input: string, cwd: string, home: string): string {
  return realpathOrNearest(resolve(cwd, expandHome(input, home)));
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
