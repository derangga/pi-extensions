import { delimiter, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/** Environment and read-only host paths made visible to a strict shell. */
export interface StrictEnvironment {
  env: NodeJS.ProcessEnv;
  runtimeRoots: string[];
}

const SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SAFE_INHERITED = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM"] as const;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

interface RuntimePath {
  path: string;
  root: string;
}

const HOME_BIN_ONLY = /^(?:bin|\.local\/bin|\.cargo\/bin|go\/bin|Library\/pnpm)$/;
const HOME_TOOLCHAIN = [
  /^\.nvm\/versions\/node\/[^/]+\/bin$/,
  /^\.local\/share\/fnm\/node-versions\/[^/]+\/installation\/bin$/,
  /^(?:\.volta|\.bun)\/bin$/,
];

/** Keep home-directory PATH mounts to known toolchain layouts. */
function runtimePath(pathEntry: string, hostHome: string): RuntimePath | undefined {
  const lexical = resolve(pathEntry);
  const path = canonical(lexical);
  if (SYSTEM_PATHS.includes(lexical)) {
    return { path, root: path };
  }

  const homeRelative = relative(resolve(hostHome), lexical).replaceAll("\\", "/");
  const insideHome =
    homeRelative === "" || (homeRelative !== ".." && !homeRelative.startsWith("../"));
  if (insideHome) {
    if (HOME_BIN_ONLY.test(homeRelative)) {
      return { path, root: path };
    }
    if (HOME_TOOLCHAIN.some((pattern) => pattern.test(homeRelative))) {
      return { path, root: dirname(path) };
    }
    return undefined;
  }

  return { path, root: path.endsWith("/bin") ? dirname(path) : path };
}

/** Build a new environment. Never spread process.env into a strict command. */
export function buildStrictEnvironment(
  source: NodeJS.ProcessEnv,
  syntheticHome: string,
  temporaryDirectory: string,
  shellPath: string,
  workspace: string,
): StrictEnvironment {
  const pathEntries = (source["PATH"] ?? SYSTEM_PATHS.join(delimiter))
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry) && entry !== parse(entry).root);
  const runtimePaths = [...pathEntries, ...SYSTEM_PATHS]
    .map((entry) => runtimePath(entry, source["HOME"] ?? homedir()))
    .filter((entry): entry is RuntimePath => entry !== undefined);
  const path = [...new Set(runtimePaths.map((entry) => entry.path))];
  const env: NodeJS.ProcessEnv = {
    HOME: syntheticHome,
    TMPDIR: temporaryDirectory,
    PATH: [resolve(workspace, "node_modules/.bin"), ...path].join(delimiter),
    SHELL: shellPath,
    CI: "1",
  };
  for (const name of SAFE_INHERITED) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  if (env["LANG"] === undefined && env["LC_ALL"] === undefined) {
    env["LANG"] = "C";
  }
  if (env["TERM"] === undefined) {
    env["TERM"] = "dumb";
  }
  return {
    env,
    runtimeRoots: [...new Set(runtimePaths.map((entry) => entry.root))],
  };
}
