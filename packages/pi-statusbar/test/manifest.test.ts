import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Every assertion here encodes a packaging decision that is
 * invisible at a glance and expensive to discover after publishing: a stray
 * runtime dependency, a peer range wider than the audit proved, a missing
 * attribution line, an entry point that does not ship.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  exports?: Record<string, string>;
  pi?: { extensions?: string[] };
  publishConfig?: { access?: string };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

describe("pi-statusbar manifest", () => {
  it("ships zero runtime dependencies", () => {
    expect(readManifest().dependencies).toBeUndefined();
  });

  it("does not depend on chalk, at any strength", () => {
    // pi-footer takes chalk as a hard dependency for 256-color and truecolor
    // output. This package emits those escape codes itself, so chalk must not
    // reappear as a dependency, a peer, or an optional peer.
    const manifest = readManifest();
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("chalk");
    expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain("chalk");
  });

  it("peers exactly the two Pi packages it imports", () => {
    // Nothing else belongs here. In particular not typebox: this extension
    // registers no tool, so it never builds a schema.
    expect(Object.keys(readManifest().peerDependencies ?? {}).sort()).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]);
  });

  it("peers Pi at the range the .d.ts audit proved safe", () => {
    // Diffing published types for 0.80.6 against 0.84.4: setFooter, the
    // readonly footer data provider (getGitBranch, onBranchChange,
    // getExtensionStatuses), getContextUsage, getThinkingLevel and Theme.fg
    // are identical. Pi's changelog puts the true floor lower still, at the
    // 0.49.0 release that added getContextUsage.
    const peers = readManifest().peerDependencies ?? {};
    expect(peers["@earendil-works/pi-coding-agent"]).toBe(">=0.80");
    expect(peers["@earendil-works/pi-tui"]).toBe(">=0.80");
  });

  it("points pi.extensions at a file that exists", () => {
    const entries = readManifest().pi?.extensions ?? [];
    expect(entries).not.toHaveLength(0);
    for (const entry of entries) {
      expect(existsSync(join(packageRoot, entry))).toBe(true);
    }
  });

  it("resolves every export target on disk", () => {
    const targets = Object.values(readManifest().exports ?? {});
    expect(targets).not.toHaveLength(0);
    for (const target of targets) {
      expect(existsSync(join(packageRoot, target))).toBe(true);
    }
  });

  it("publishes source, docs and legal text, and nothing else", () => {
    const files = readManifest().files ?? [];
    expect(files).toContain("src/");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).not.toContain("test/");
  });

  it("is public, MIT, and starts at 0.1.0", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("pi-statusbar");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("credits both copyright holders in LICENSE", () => {
    // MIT terms require the original notice to survive the fork. Dropping the
    // wobondar line would make the package unlicensed, not merely impolite.
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 wobondar");
    expect(license).toContain("Copyright (c) 2026 derangga");
  });
});
