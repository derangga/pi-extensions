import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildStrictEnvironment } from "./environment.js";
import { isInside } from "./paths.js";
import type { Rule } from "./rules.js";
import {
  discoverExplicitTargets,
  discoverProtectedTargets,
  type ProtectedTarget,
} from "./targets.js";

export type BackendName = "sandbox-exec" | "bwrap";

export interface Backend {
  name: BackendName;
  executable: string;
}

export interface SandboxSpec {
  workspace: string;
  commandCwd: string;
  shellPath: string;
  targets: readonly ProtectedTarget[];
  rules: readonly Rule[];
  home: string;
  sourceEnvironment: NodeJS.ProcessEnv;
}

export interface ReadyJail {
  state: "ready";
  backend: BackendName;
  launcher: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  home: string;
  temporaryDirectory: string;
  cleanupRoot: string;
  profilePath: string;
}

export interface BlockedJail {
  state: "blocked";
  reason: string;
}

export type Jail = ReadyJail | BlockedJail;

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BSD_PROFILE = "/System/Library/Sandbox/Profiles/bsd.sb";
const SYSTEM_RUNTIME_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library/Apple",
  "/lib",
  "/lib64",
  "/nix/store",
  "/run/current-system/sw",
];
const LINUX_RUNTIME_PATHS = [
  "/etc/group",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/nsswitch.conf",
  "/etc/passwd",
];

interface BwrapMount {
  kind: "bind" | "symlink";
  source: string;
  target: string;
}

const runtimeRuleCaches = new WeakMap<readonly Rule[], readonly Rule[]>();

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const directory of (path ?? "").split(delimiter)) {
    if (directory === "") {
      continue;
    }
    const candidate = resolve(directory, name);
    if (executable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Resolve the backend executable now. Strict mode never relies on shell PATH lookup. */
export function pickBackend(platform: string, path = process.env["PATH"]): Backend | undefined {
  if (platform === "darwin") {
    return executable(SANDBOX_EXEC)
      ? { name: "sandbox-exec", executable: SANDBOX_EXEC }
      : undefined;
  }
  if (platform === "linux") {
    const candidate = findOnPath("bwrap", path);
    return candidate === undefined ? undefined : { name: "bwrap", executable: candidate };
  }
  return undefined;
}

function canonicalDirectory(path: string, label: string): string {
  const real = realpathSync(path);
  if (!existsSync(real)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  return real;
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function uniqueExisting(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    if (existsSync(path)) {
      found.add(realpathSync(path));
    }
  }
  return [...found];
}

function bwrapMounts(paths: readonly string[]): BwrapMount[] {
  const mounts = new Map<string, BwrapMount>();
  for (const path of paths) {
    if (!existsSync(path) || mounts.has(path)) {
      continue;
    }
    if (lstatSync(path).isSymbolicLink()) {
      mounts.set(path, { kind: "symlink", source: readlinkSync(path), target: path });
    } else {
      mounts.set(path, { kind: "bind", source: path, target: path });
    }
  }
  return [...mounts.values()];
}

function protectedWorkspaceAncestors(
  workspace: string,
  targets: readonly ProtectedTarget[],
): string[] {
  const ancestors = new Set<string>();
  for (const target of targets) {
    if (!isInside(workspace, target.path) || target.path === workspace) {
      continue;
    }
    let current = dirname(target.path);
    while (current !== workspace && isInside(workspace, current)) {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  return [...ancestors];
}

export function buildSbpl(
  workspace: string,
  home: string,
  temporaryDirectory: string,
  runtimeRoots: readonly string[],
  targets: readonly ProtectedTarget[],
): string {
  const readable = uniqueExisting([...SYSTEM_RUNTIME_ROOTS, ...runtimeRoots]);
  const lines = [
    "(version 1)",
    `(import ${sbplString(BSD_PROFILE)})`,
    "(deny network*)",
    "(deny file-read*)",
    "(deny file-write*)",
    '(deny mach-lookup (global-name "com.apple.securityd"))',
    '(deny mach-lookup (global-name "com.apple.trustd"))',
    "(allow process-exec* process-fork signal sysctl-read)",
    "(allow file-read-metadata)",
    ...readable.map((path) => `(allow file-read* (subpath ${sbplString(path)}))`),
    `(allow file-read* file-write* (subpath ${sbplString(workspace)}))`,
    `(allow file-read* file-write* (subpath ${sbplString(home)}))`,
    `(allow file-read* file-write* (subpath ${sbplString(temporaryDirectory)}))`,
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/zero"))',
    '(allow file-read* (literal "/dev/random"))',
    '(allow file-read* (literal "/dev/urandom"))',
  ];
  for (const ancestor of protectedWorkspaceAncestors(workspace, targets)) {
    lines.push(`(deny file-write* (literal ${sbplString(ancestor)}))`);
  }
  for (const target of targets) {
    const filter = target.directory ? "subpath" : "literal";
    lines.push(`(deny file-read* file-write* (${filter} ${sbplString(target.path)}))`);
  }
  lines.push("");
  return lines.join("\n");
}

function discoverRuntimeTargets(
  runtimeRoots: readonly string[],
  workspace: string,
  rules: readonly Rule[],
  home: string,
): ProtectedTarget[] {
  const systemRoots = uniqueExisting(SYSTEM_RUNTIME_ROOTS);
  let locationRules = runtimeRuleCaches.get(rules);
  if (locationRules === undefined) {
    locationRules = rules.filter(
      (rule) => !rule.glob.includes("/") || rule.glob.startsWith("/") || rule.glob.startsWith("~/"),
    );
    runtimeRuleCaches.set(rules, locationRules);
  }
  return runtimeRoots.flatMap((root) => {
    if (
      !existsSync(root) ||
      isInside(workspace, root) ||
      systemRoots.some((systemRoot) => isInside(systemRoot, root))
    ) {
      return [];
    }
    return discoverProtectedTargets(root, locationRules, home, false);
  });
}

function uniqueTargets(targets: readonly ProtectedTarget[]): ProtectedTarget[] {
  const found = new Map<string, ProtectedTarget>();
  for (const target of targets) {
    const previous = found.get(target.path);
    const merged: ProtectedTarget = {
      path: target.path,
      directory: target.directory || previous?.directory === true,
    };
    const rule = previous?.rule ?? target.rule;
    if (rule !== undefined) {
      merged.rule = rule;
    }
    found.set(target.path, merged);
  }
  return [...found.values()];
}

function addEnvironment(args: string[], env: NodeJS.ProcessEnv): void {
  args.push("--clearenv");
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      args.push("--setenv", name, value);
    }
  }
}

function parentDirectories(path: string): string[] {
  const directories: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== ".") {
    directories.unshift(current);
    current = dirname(current);
  }
  return directories;
}

function addDirectories(args: string[], paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths.flatMap(parentDirectories)) {
    if (!seen.has(path)) {
      seen.add(path);
      args.push("--dir", path);
    }
  }
}

export function buildBwrapArgs(
  workspace: string,
  commandCwd: string,
  home: string,
  temporaryDirectory: string,
  emptyDirectory: string,
  runtimeRoots: readonly string[],
  targets: readonly ProtectedTarget[],
  env: NodeJS.ProcessEnv,
): string[] {
  const mounts = bwrapMounts([...SYSTEM_RUNTIME_ROOTS, ...LINUX_RUNTIME_PATHS, ...runtimeRoots]);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/",
  ];
  addDirectories(args, [
    workspace,
    home,
    temporaryDirectory,
    ...mounts.map((mount) => mount.target),
  ]);
  args.push("--proc", "/proc", "--dev", "/dev");
  for (const mount of mounts) {
    if (mount.kind === "symlink") {
      args.push("--symlink", mount.source, mount.target);
    } else {
      args.push("--ro-bind", mount.source, mount.target);
    }
  }
  args.push(
    "--bind",
    workspace,
    workspace,
    "--bind",
    home,
    home,
    "--bind",
    temporaryDirectory,
    temporaryDirectory,
  );
  for (const target of targets) {
    args.push("--ro-bind", target.directory ? emptyDirectory : "/dev/null", target.path);
  }
  addEnvironment(args, env);
  args.push("--chdir", commandCwd);
  return args;
}

/** Build an immutable jail for one command. Any setup failure becomes blocked state. */
export function buildJail(backend: Backend | undefined, spec: SandboxSpec): Jail {
  if (backend === undefined) {
    return { state: "blocked", reason: "no supported OS sandbox backend is available" };
  }
  let cleanupRoot: string | undefined;
  try {
    const workspace = canonicalDirectory(spec.workspace, "workspace");
    const commandCwd = canonicalDirectory(spec.commandCwd, "command cwd");
    const shellPath = realpathSync(spec.shellPath);
    cleanupRoot = mkdtempSync(join(tmpdir(), "pi-sandboxing-"));
    const homePath = join(cleanupRoot, "home");
    const temporaryPath = join(cleanupRoot, "tmp");
    const emptyPath = join(cleanupRoot, "empty");
    mkdirSync(homePath);
    mkdirSync(temporaryPath);
    mkdirSync(emptyPath);
    const home = realpathSync(homePath);
    const temporaryDirectory = realpathSync(temporaryPath);
    const emptyDirectory = realpathSync(emptyPath);
    const strict = buildStrictEnvironment(
      spec.sourceEnvironment,
      home,
      temporaryDirectory,
      shellPath,
      workspace,
    );
    const visibleRuntimeRoots = uniqueExisting([
      ...SYSTEM_RUNTIME_ROOTS,
      ...(backend.name === "bwrap" ? LINUX_RUNTIME_PATHS : []),
      ...strict.runtimeRoots,
    ]);
    const targets = uniqueTargets([
      ...spec.targets,
      ...discoverRuntimeTargets(strict.runtimeRoots, workspace, spec.rules, spec.home),
      ...discoverExplicitTargets(spec.rules, spec.home, visibleRuntimeRoots),
    ]);
    if (backend.name === "bwrap") {
      return {
        state: "ready",
        backend: backend.name,
        launcher: backend.executable,
        args: buildBwrapArgs(
          workspace,
          commandCwd,
          home,
          temporaryDirectory,
          emptyDirectory,
          strict.runtimeRoots,
          targets,
          strict.env,
        ),
        env: strict.env,
        home,
        temporaryDirectory,
        cleanupRoot,
        profilePath: "",
      };
    }
    const profilePath = join(cleanupRoot, "profile.sb");
    writeFileSync(
      profilePath,
      buildSbpl(workspace, home, temporaryDirectory, strict.runtimeRoots, targets),
      "utf8",
    );
    return {
      state: "ready",
      backend: backend.name,
      launcher: backend.executable,
      args: ["-f", profilePath],
      env: strict.env,
      home,
      temporaryDirectory,
      cleanupRoot,
      profilePath,
    };
  } catch (error) {
    if (cleanupRoot !== undefined) {
      rmSync(cleanupRoot, { recursive: true, force: true });
    }
    return {
      state: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface Invocation {
  file: string;
  args: string[];
}

export function jailCommand(
  jail: Jail,
  shellPath: string,
  args: readonly string[],
): Invocation | undefined {
  if (jail.state === "blocked") {
    return undefined;
  }
  return { file: jail.launcher, args: [...jail.args, shellPath, ...args] };
}

export function cleanupJail(jail: Jail): void {
  if (jail.state === "ready") {
    rmSync(jail.cleanupRoot, { recursive: true, force: true });
  }
}
