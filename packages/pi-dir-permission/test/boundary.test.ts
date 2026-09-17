import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  baselineRoots,
  grantLabel,
  grantScopes,
  isAllowed,
  isDirectory,
  isInside,
  resolveCandidate,
} from "../src/boundary.js";
import { describe, expect, it } from "vitest";

/**
 * Every fixture lives under one temp root, realpath'd because macOS symlinks
 * /var. Nothing cleans it up: the OS reclaims its own temp directory, and a
 * recursive delete in a suite that builds symlinks is the wrong thing to get
 * wrong.
 */
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "dir-permission-")));

function fixture(...segments: string[]): string {
  const target = join(fixtureRoot, ...segments);
  mkdirSync(target, { recursive: true });
  return target;
}

describe("isInside", () => {
  it("accepts the root itself and anything under it", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d.ts")).toBe(true);
  });

  it("rejects a sibling that merely shares a prefix", () => {
    // The trap a string prefix check falls into: /a/bc starts with /a/b.
    expect(isInside("/a/b", "/a/bc")).toBe(false);
  });

  it("rejects a parent and an unrelated path", () => {
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/x/y")).toBe(false);
  });
});

describe("isAllowed", () => {
  it("passes when any root contains the candidate", () => {
    expect(isAllowed(["/a", "/b"], "/b/c")).toBe(true);
    expect(isAllowed(["/a", "/b"], "/c")).toBe(false);
    expect(isAllowed([], "/a")).toBe(false);
  });
});

describe("resolveCandidate", () => {
  it("resolves a relative path against the given cwd", () => {
    const workspace = fixture("workspace");
    expect(resolveCandidate("src", workspace)).toBe(join(workspace, "src"));
  });

  it("expands ~ to the home directory", () => {
    expect(resolveCandidate("~", fixtureRoot)).toBe(realpathSync(homedir()));
  });

  it("keeps the part of the path that does not exist yet", () => {
    // `write` names files that are not there, and the prefix still has to be
    // compared against the boundary.
    const workspace = fixture("pending");
    expect(resolveCandidate("a/b/new-file.ts", workspace)).toBe(
      join(workspace, "a", "b", "new-file.ts"),
    );
  });

  it("follows a symlink that points out of the workspace", () => {
    const workspace = fixture("linked-workspace");
    const outside = fixture("outside-target");
    const link = join(workspace, "escape");
    symlinkSync(outside, link);
    expect(resolveCandidate("escape/file.ts", workspace)).toBe(join(outside, "file.ts"));
    expect(isInside(workspace, resolveCandidate("escape", workspace))).toBe(false);
  });
});

describe("baselineRoots", () => {
  it("covers the workspace, the temp directory and Pi's agent directory", () => {
    const workspace = fixture("baseline");
    const agentDir = fixture("agent");
    const roots = baselineRoots(workspace, agentDir);
    expect(isAllowed(roots, join(workspace, "src", "index.ts"))).toBe(true);
    expect(isAllowed(roots, join(realpathSync(tmpdir()), "scratch.txt"))).toBe(true);
    expect(isAllowed(roots, join(agentDir, "sessions", "a.jsonl"))).toBe(true);
  });
});

describe("grantScopes", () => {
  it("offers the parent directory for a file", () => {
    const dir = fixture("scopes", "plain", "src");
    const file = join(dir, "main.ts");
    writeFileSync(file, "");
    expect(grantScopes(file, homedir())).toEqual({ dir, repoRoot: undefined });
  });

  it("offers the directory itself when the target is one", () => {
    const dir = fixture("scopes", "as-dir");
    expect(grantScopes(dir, homedir()).dir).toBe(dir);
  });

  it("offers the enclosing repository as the wider scope", () => {
    const repo = fixture("scopes", "repo");
    mkdirSync(join(repo, ".git"));
    const inner = fixture("scopes", "repo", "packages", "app");
    expect(grantScopes(inner, homedir())).toEqual({ dir: inner, repoRoot: repo });
  });

  it("offers nothing wider when the directory is already the repository root", () => {
    const repo = fixture("scopes", "repo-root");
    mkdirSync(join(repo, ".git"));
    expect(grantScopes(repo, homedir()).repoRoot).toBeUndefined();
  });

  it("never offers the home directory, however many .git files sit above", () => {
    const home = fixture("scopes", "home");
    mkdirSync(join(home, ".git"));
    const inner = fixture("scopes", "home", "projects", "app");
    expect(grantScopes(inner, home).repoRoot).toBeUndefined();
  });
});

describe("isDirectory and grantLabel", () => {
  it("reports directories, files and missing paths apart", () => {
    const dir = fixture("labels");
    const file = join(dir, "note.txt");
    writeFileSync(file, "");
    expect(isDirectory(dir)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(join(dir, "absent"))).toBe(false);
  });

  it("labels a grant with its directory name", () => {
    const dir = fixture("labels", "neighbour-repo");
    expect(grantLabel(dir)).toBe("neighbour-repo");
    expect(grantLabel(dirname(dir))).toBe(basename(dirname(dir)));
  });
});
