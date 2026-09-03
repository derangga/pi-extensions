import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asyncCache } from "../src/cache.js";
import { configWithPreset, DEFAULT_CONFIG } from "../src/config.js";
import {
  EMPTY_GIT_INFO,
  getGitInfo,
  gitCommandsFor,
  parseAheadBehind,
  parsePorcelain,
  parseShortstat,
  type GitCommand,
} from "../src/git.js";
import type { GitInfo, WidgetEntry } from "../src/types.js";
import type { Preset } from "../src/presets.js";
import { registry, type WidgetType } from "../src/widgets/registry.js";

// Verbatim output from real commands run in a scratch repository. Hand-written
// fixtures are where a parser test quietly stops testing the parser.
const PORCELAIN_UNSTAGED_FIRST = " D deleted.txt\n M kept.txt\n?? extra.txt";
const PORCELAIN_MIXED =
  "AM both.txt\n D deleted.txt\n M kept.txt\nR  renamed.txt -> newname.txt\nA  staged-new.txt\n?? untracked.txt";
const SHORTSTAT = " 5 files changed, 5 insertions(+), 1 deletion(-)";
const AHEAD_BEHIND = "1\t1";

describe("parsePorcelain", () => {
  it("counts staged, unstaged and untracked from real status output", () => {
    expect(parsePorcelain(PORCELAIN_MIXED)).toEqual({ staged: 3, unstaged: 3, untracked: 1 });
  });

  it("keeps the significant leading space of the first line", () => {
    // Every change here is unstaged, so column 1 is a space on every line. A
    // parser fed trim()ed output reads the first line's status letter out of
    // column 2 and reports one staged file that does not exist.
    expect(parsePorcelain(PORCELAIN_UNSTAGED_FIRST)).toEqual({
      staged: 0,
      unstaged: 2,
      untracked: 1,
    });
  });

  it("reports a clean tree for absent or empty output", () => {
    const clean = { staged: 0, unstaged: 0, untracked: 0 };
    expect(parsePorcelain(null)).toEqual(clean);
    expect(parsePorcelain("")).toEqual(clean);
  });
});

describe("parseShortstat", () => {
  it("reads both counts from real diff output", () => {
    expect(parseShortstat(SHORTSTAT)).toEqual({ insertions: 5, deletions: 1 });
  });

  it("reads a half that is present when the other is missing", () => {
    expect(parseShortstat(" 1 file changed, 2 insertions(+)")).toEqual({
      insertions: 2,
      deletions: 0,
    });
    expect(parseShortstat(" 1 file changed, 3 deletions(-)")).toEqual({
      insertions: 0,
      deletions: 3,
    });
    expect(parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)")).toEqual({
      insertions: 1,
      deletions: 1,
    });
  });

  it("reports no change for absent output", () => {
    expect(parseShortstat(null)).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe("parseAheadBehind", () => {
  it("reads behind before ahead, the order the command prints them", () => {
    expect(parseAheadBehind(AHEAD_BEHIND)).toEqual({ ahead: 1, behind: 1 });
    expect(parseAheadBehind("0\t4")).toEqual({ ahead: 4, behind: 0 });
    expect(parseAheadBehind("2\t0")).toEqual({ ahead: 0, behind: 2 });
  });

  it("reports level for absent or unreadable output", () => {
    const level = { ahead: 0, behind: 0 };
    expect(parseAheadBehind(null)).toEqual(level);
    expect(parseAheadBehind("fatal: no upstream configured")).toEqual(level);
  });
});

function linesFor(preset: Preset): WidgetEntry[][] {
  return configWithPreset(DEFAULT_CONFIG, preset).lines;
}

function entry(type: WidgetType, enabled = true): WidgetEntry {
  return { ...registry.createEntry(type), enabled };
}

describe("gitCommandsFor", () => {
  it("asks for nothing when no git widget is enabled", () => {
    expect(gitCommandsFor([[entry("model"), entry("cost")]])).toBeUndefined();
    expect(gitCommandsFor([])).toBeUndefined();
  });

  it("ignores a git widget that is switched off", () => {
    expect(gitCommandsFor([[entry("model"), entry("git-status", false)]])).toBeUndefined();
  });

  it("collects nothing extra for a branch on its own, since Pi already watches it", () => {
    expect([...(gitCommandsFor([[entry("git-branch")]]) ?? [])]).toEqual([]);
  });

  it("asks for one command beyond the probe on the default and compact presets", () => {
    expect(gitCommandsFor(linesFor("default"))).toEqual(new Set<GitCommand>(["shortstat"]));
    expect(gitCommandsFor(linesFor("compact"))).toEqual(new Set<GitCommand>([]));
  });

  it("asks for more on git-heavy than on compact, and a superset of it", () => {
    const heavy = gitCommandsFor(linesFor("git-heavy")) ?? new Set<GitCommand>();
    const compact = gitCommandsFor(linesFor("compact")) ?? new Set<GitCommand>();

    expect(heavy).toEqual(new Set<GitCommand>(["sha", "porcelain", "shortstat", "aheadBehind"]));
    expect(heavy.size).toBeGreaterThan(compact.size);
    for (const command of compact) expect(heavy.has(command)).toBe(true);
  });
});

const OUTPUT: Record<string, string> = {
  "rev-parse --show-toplevel": "/repo",
  "rev-parse --short HEAD": "abc1234",
  "status --porcelain=v1": PORCELAIN_MIXED,
  "diff --shortstat HEAD": SHORTSTAT,
  "rev-list --left-right --count @{upstream}...HEAD": AHEAD_BEHIND,
};

interface Stub {
  pi: ExtensionAPI;
  calls: string[];
}

function stubPi(output: Record<string, string> = OUTPUT, failing: readonly string[] = []): Stub {
  const calls: string[] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      const key = args.join(" ");
      calls.push(key);
      if (failing.includes(key)) throw new Error(`exec failed: ${key}`);
      const stdout = output[key];
      return stdout === undefined
        ? { stdout: "", stderr: "fatal", code: 128, killed: false }
        : { stdout: `${stdout}\n`, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

/** Reads through the cache, waiting for the background fetch to land. */
function collect(
  stub: Stub,
  commands: readonly GitCommand[],
  cwd: string,
  branchHint: string | null = "main",
): Promise<GitInfo> {
  const set = new Set(commands);
  return new Promise((resolve) => {
    getGitInfo(stub.pi, cwd, branchHint, set, () => {
      resolve(getGitInfo(stub.pi, cwd, branchHint, set, () => {}));
    });
  });
}

describe("getGitInfo", () => {
  beforeEach(() => {
    asyncCache.clear();
  });

  it("returns an empty snapshot before the first fetch lands", () => {
    const stub = stubPi();
    expect(getGitInfo(stub.pi, "/repo", "main", new Set(["sha"]), () => {})).toEqual(
      EMPTY_GIT_INFO,
    );
  });

  it("runs only the commands it was asked for", async () => {
    const stub = stubPi();
    await collect(stub, ["shortstat"], "/only-shortstat");

    expect(stub.calls).toEqual(["rev-parse --show-toplevel", "diff --shortstat HEAD"]);
  });

  it("fills the whole snapshot when every command is asked for", async () => {
    const stub = stubPi();
    const info = await collect(stub, ["sha", "porcelain", "shortstat", "aheadBehind"], "/all");

    expect(info).toEqual({
      branch: "main",
      sha: "abc1234",
      staged: 3,
      unstaged: 3,
      untracked: 1,
      insertions: 5,
      deletions: 1,
      ahead: 1,
      behind: 1,
      isRepo: true,
    });
  });

  it("trims only the trailing newline off status output", async () => {
    // The status columns are positional, so the leading space of the first line
    // carries meaning. A collector that trim()s the command's output loses it
    // and credits an unstaged file to the index.
    const stub = stubPi({
      ...OUTPUT,
      "status --porcelain=v1": PORCELAIN_UNSTAGED_FIRST,
    });
    const info = await collect(stub, ["porcelain"], "/leading-space");

    expect(info.staged).toBe(0);
    expect(info.unstaged).toBe(2);
    expect(info.untracked).toBe(1);
  });

  it("takes the branch from the hint rather than a subprocess", async () => {
    const stub = stubPi();
    const info = await collect(stub, [], "/branch-only", "feature/x");

    expect(info.branch).toBe("feature/x");
    expect(stub.calls).toEqual(["rev-parse --show-toplevel"]);
  });

  it("stops at the probe outside a repository", async () => {
    const stub = stubPi({});
    const info = await collect(stub, ["sha", "porcelain"], "/not-a-repo");

    expect(info).toEqual(EMPTY_GIT_INFO);
    expect(stub.calls).toEqual(["rev-parse --show-toplevel"]);
  });

  it("keeps the rest of the snapshot when one command cannot run", async () => {
    const stub = stubPi(OUTPUT, ["status --porcelain=v1"]);
    const info = await collect(stub, ["porcelain", "shortstat"], "/one-failure");

    expect(info.staged).toBe(0);
    expect(info.insertions).toBe(5);
    expect(info.isRepo).toBe(true);
  });

  it("caches a fresh snapshot instead of re-running the commands", async () => {
    const stub = stubPi();
    await collect(stub, ["shortstat"], "/cached");
    const callCount = stub.calls.length;

    getGitInfo(stub.pi, "/cached", "main", new Set<GitCommand>(["shortstat"]), () => {});
    expect(stub.calls).toHaveLength(callCount);
  });

  it("refetches when the command set grows, rather than reusing a thinner snapshot", async () => {
    const stub = stubPi();
    const thin = await collect(stub, ["shortstat"], "/same-dir");
    expect(thin.sha).toBeNull();
    // Same directory, same branch, one more command. A cache keyed on the
    // directory alone would hit the snapshot above while it is still fresh and
    // report no sha for a git-sha widget that just came on.
    const wide = new Set<GitCommand>(["shortstat", "sha"]);
    getGitInfo(stub.pi, "/same-dir", "main", wide, () => {});
    await vi.waitFor(() => expect(stub.calls).toContain("rev-parse --short HEAD"));

    expect(getGitInfo(stub.pi, "/same-dir", "main", wide, () => {}).sha).toBe("abc1234");
  });
});
