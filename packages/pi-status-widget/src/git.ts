import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { asyncCache } from "./cache.js";
import type { GitInfo } from "./types.js";
import type { WidgetType } from "./widgets/registry.js";

const CACHE_TTL_MS = 2000;
const COMMAND_TIMEOUT_MS = 500;

export const EMPTY_GIT_INFO: GitInfo = {
  branch: null,
  sha: null,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  insertions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  isRepo: false,
};

/** One subprocess each, beyond the repository probe every collection starts with. */
export type GitCommand = "sha" | "porcelain" | "shortstat" | "aheadBehind";

type GitWidgetType = Extract<WidgetType, `git-${string}`>;

/**
 * Which command feeds which widget. Exhaustive over the git widgets on purpose:
 * add one without deciding what it costs and this stops compiling.
 *
 * git-branch reads the hint Pi already keeps for us through footerData, which
 * fs-watches the ref rather than shelling out, so the branch is free.
 */
const COMMAND_FOR_WIDGET: Record<GitWidgetType, GitCommand | null> = {
  "git-branch": null,
  "git-sha": "sha",
  "git-status": "porcelain",
  "git-diff": "shortstat",
  "git-ahead-behind": "aheadBehind",
};

interface EnabledWidget {
  readonly type: string;
  readonly enabled: boolean;
}

/**
 * The commands the enabled widgets actually need. This is the one place the
 * package diverges from pi-footer on purpose: upstream runs all seven every
 * refresh whenever any git widget is on, two of them feeding widgets this
 * package does not ship. Here `compact` costs one subprocess beyond the probe
 * and `git-heavy` costs four.
 *
 * Undefined when no git widget is enabled at all, which means no collection and
 * no subprocess rather than an empty fetch.
 */
export function gitCommandsFor(
  lines: readonly (readonly EnabledWidget[])[],
): ReadonlySet<GitCommand> | undefined {
  const commands = new Set<GitCommand>();
  let anyGitWidget = false;

  for (const line of lines) {
    for (const widget of line) {
      if (!widget.enabled) continue;
      if (!Object.hasOwn(COMMAND_FOR_WIDGET, widget.type)) continue;
      anyGitWidget = true;
      const command = COMMAND_FOR_WIDGET[widget.type as GitWidgetType];
      if (command) commands.add(command);
    }
  }

  return anyGitWidget ? commands : undefined;
}

interface GitFetch {
  pi: ExtensionAPI;
  cwd: string;
  branchHint: string | null;
  commands: ReadonlySet<GitCommand>;
}

/**
 * The cached snapshot, immediately. A stale value is returned as it is while a
 * refresh runs behind it, and requestRender repaints when fresh data lands, so
 * a draw never waits on a subprocess.
 *
 * The command set is part of the cache key. Upstream keys on the directory
 * alone, which is safe only while every refresh runs the same commands; once
 * the set follows the config, a preset switch would otherwise read back a
 * snapshot collected without the commands the new widgets need and show zeros.
 */
export function getGitInfo(
  pi: ExtensionAPI,
  cwd: string,
  branchHint: string | null,
  commands: ReadonlySet<GitCommand>,
  requestRender: () => void,
): GitInfo {
  const key = `${cwd}|${branchHint ?? ""}|${[...commands].sort().join(",")}`;
  return (
    asyncCache.get(
      key,
      CACHE_TTL_MS,
      { pi, cwd, branchHint, commands },
      fetchGitInfo,
      requestRender,
    ) ?? EMPTY_GIT_INFO
  );
}

async function fetchGitInfo({ pi, cwd, branchHint, commands }: GitFetch): Promise<GitInfo> {
  const inRepo = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (!inRepo) return EMPTY_GIT_INFO;

  const [sha, porcelain, shortstat, aheadBehind] = await Promise.all([
    commands.has("sha") ? git(pi, cwd, ["rev-parse", "--short", "HEAD"]) : null,
    commands.has("porcelain") ? git(pi, cwd, ["status", "--porcelain=v1"]) : null,
    commands.has("shortstat") ? git(pi, cwd, ["diff", "--shortstat", "HEAD"]) : null,
    commands.has("aheadBehind")
      ? git(pi, cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
      : null,
  ]);

  return {
    branch: branchHint,
    sha,
    ...parsePorcelain(porcelain),
    ...parseShortstat(shortstat),
    ...parseAheadBehind(aheadBehind),
    isRepo: true,
  };
}

/**
 * Null on any failure: a non-zero exit, a kill at the timeout, or exec itself
 * rejecting. Caught per command rather than around the batch so one command
 * that cannot run costs its own field instead of the whole snapshot.
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, code, killed } = await pi.exec("git", args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
    });
    // trimEnd, not trim: `status --porcelain=v1` encodes staged vs unstaged in
    // columns 1/2, so the leading space of the first line is significant.
    // trim() would strip it and miscount that file.
    return code !== 0 || killed ? null : stdout.trimEnd() || null;
  } catch {
    return null;
  }
}

export function parsePorcelain(
  output: string | null,
): Pick<GitInfo, "staged" | "unstaged" | "untracked"> {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output?.split("\n") ?? []) {
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }
    if (x !== " " && x !== undefined) staged += 1;
    if (y !== " " && y !== undefined) unstaged += 1;
  }

  return { staged, unstaged, untracked };
}

export function parseShortstat(output: string | null): Pick<GitInfo, "insertions" | "deletions"> {
  const insertions = /([0-9]+) insertion/.exec(output ?? "")?.[1];
  const deletions = /([0-9]+) deletion/.exec(output ?? "")?.[1];
  return {
    insertions: insertions ? Number(insertions) : 0,
    deletions: deletions ? Number(deletions) : 0,
  };
}

/** `--left-right --count` prints behind first, then ahead, tab separated. */
export function parseAheadBehind(output: string | null): Pick<GitInfo, "ahead" | "behind"> {
  const [behind, ahead] = output?.split(/\s+/).map(Number) ?? [];
  return {
    ahead: Number.isFinite(ahead) ? (ahead ?? 0) : 0,
    behind: Number.isFinite(behind) ? (behind ?? 0) : 0,
  };
}
