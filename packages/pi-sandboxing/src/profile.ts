/**
 * The kernel half. Turns the home-directory rules into a profile that denies
 * them to every bash subprocess, and wraps a command so it runs under one.
 *
 * Nothing here imports Pi. Two findings shaped the macOS profile and are worth
 * not rediscovering:
 *
 * - `(deny default)` aborts the process with SIGABRT. dyld needs more than is
 *   obvious, so the profile imports the system's own `bsd.sb` and denies from
 *   there. Later rules win in SBPL, which is what makes that order work.
 * - An allowlist profile that confines the shell to the workspace breaks `npm`
 *   on any machine whose version manager lives under `$HOME`, which is most of
 *   them. So this is a denylist: it puts credentials out of reach rather than
 *   confining the shell.
 *
 * Repo-local rules are deliberately absent. Denying a project its own `.env`
 * breaks every test suite that loads one; the redactor covers those instead.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, resolveCandidate } from "./paths.js";
import type { Rule } from "./rules.js";

/** Which kernel mechanism is available, if any. */
export type Backend = "sandbox-exec" | "bwrap";

/** One path the profile denies, and whether it is a directory. */
export interface DenyTarget {
  path: string;
  directory: boolean;
}

export interface Jail {
  backend: Backend;
  /** Written once per session for sandbox-exec; empty for bwrap. */
  profilePath: string;
  args: readonly string[];
}

export interface Invocation {
  file: string;
  args: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BSD_PROFILE = "/System/Library/Sandbox/Profiles/bsd.sb";

/**
 * The backend for this machine, or undefined when there is none. An absent
 * binary is not an error: the gate and the redactor still work, and refusing to
 * run bash on a machine without bubblewrap would make Pi useless there.
 */
export function pickBackend(
  platform: string,
  exists: (file: string) => boolean,
): Backend | undefined {
  if (platform === "darwin") {
    return exists(SANDBOX_EXEC) ? "sandbox-exec" : undefined;
  }
  if (platform === "linux") {
    return exists("bwrap") ? "bwrap" : undefined;
  }
  return undefined;
}

/**
 * The paths a profile can deny, symlink-resolved. SBPL matches the resolved
 * path, so an unresolved target silently denies nothing: a macOS temp
 * directory handed out as `/var/folders/...` really lives under
 * `/private/var/folders/...`.
 *
 * A wildcard rule is skipped: SBPL can express a regex and bwrap cannot
 * express one at all, and a jail that silently covers half of what the rules
 * say is worse than one covering a stated subset.
 */
export function denyTargets(
  rules: readonly Rule[],
  home: string,
  isDirectory: (path: string) => boolean,
): DenyTarget[] {
  const targets: DenyTarget[] = [];
  for (const rule of rules) {
    if (rule.glob.includes("*")) {
      continue;
    }
    const expanded = expandHome(rule.glob, home).replace(/\/+$/, "");
    if (expanded === "" || expanded === home) {
      continue;
    }
    const path = resolveCandidate(expanded, home, home);
    targets.push({ path, directory: rule.glob.endsWith("/") || isDirectory(path) });
  }
  return targets;
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Allow broadly, then deny the targets, which must already be resolved:
 * `denyTargets` is the step that does that. `subpath` covers a directory and
 * everything under it, and covers a plain file as just itself, so one form
 * serves both.
 */
export function buildSbpl(targets: readonly DenyTarget[]): string {
  return [
    "(version 1)",
    `(import ${sbplString(BSD_PROFILE)})`,
    "(allow process-exec* process-fork signal sysctl-read)",
    "(allow file-read*)",
    "(allow file-write*)",
    "(allow mach-lookup ipc-posix-shm)",
    "(allow network*)",
    ...targets.map(
      (target) => `(deny file-read* file-write* (subpath ${sbplString(target.path)}))`,
    ),
    "",
  ].join("\n");
}

/**
 * Share the filesystem, then cover each denied path: a tmpfs hides a directory,
 * and /dev/null bound over a file makes it readable but empty. Unverified
 * against a real bubblewrap, which is not installed on the author's machine.
 */
export function buildBwrapArgs(targets: readonly DenyTarget[]): string[] {
  const args = ["--dev-bind", "/", "/", "--die-with-parent"];
  for (const target of targets) {
    if (target.directory) {
      args.push("--tmpfs", target.path);
      continue;
    }
    args.push("--bind", "/dev/null", target.path);
  }
  return args;
}

/**
 * A jail for this session, or undefined when there is nothing to deny. Writing
 * the profile once per session keeps it off the command line, where a long
 * profile would blow the argument limit.
 */
export function buildJail(
  backend: Backend | undefined,
  targets: readonly DenyTarget[],
): Jail | undefined {
  if (backend === undefined || targets.length === 0) {
    return undefined;
  }
  if (backend === "bwrap") {
    return { backend, profilePath: "", args: buildBwrapArgs(targets) };
  }
  const directory = mkdtempSync(join(tmpdir(), "pi-sandboxing-"));
  const profilePath = join(directory, "profile.sb");
  writeFileSync(profilePath, buildSbpl(targets), "utf8");
  return { backend, profilePath, args: ["-f", profilePath] };
}

/** The command to run instead of `file`, or undefined when there is no jail. */
export function jailCommand(
  jail: Jail | undefined,
  file: string,
  args: readonly string[],
): Invocation | undefined {
  if (jail === undefined) {
    return undefined;
  }
  return {
    file: jail.backend === "bwrap" ? "bwrap" : SANDBOX_EXEC,
    args: [...jail.args, file, ...args],
  };
}
