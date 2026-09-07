import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Every assertion here encodes a packaging decision that is
 * invisible at a glance and expensive to discover after publishing: a second
 * runtime dependency, the wrong typebox package name, a peer range wider than
 * the API audit supports, an entry point that does not ship.
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
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

describe("pi-broodmother manifest", () => {
  it("ships exactly one runtime dependency, and it is effect", () => {
    // The repo rule is fewest dependencies, not zero, and this package spends
    // its one on Effect. An exact count is the point: a second dependency has
    // to fail here rather than arrive unnoticed.
    const dependencies = readManifest().dependencies ?? {};
    expect(Object.keys(dependencies)).toEqual(["effect"]);
  });

  it("declares typebox, not @sinclair/typebox, as a peer", () => {
    // Pi 0.84.4 depends on `typebox@1.3.7`. The old `@sinclair/typebox` name is
    // a different package, and peering it resolves to something Pi never loads.
    const peers = readManifest().peerDependencies ?? {};
    expect(peers).toHaveProperty("typebox");
    expect(peers).not.toHaveProperty("@sinclair/typebox");
  });

  it("peers Pi no wider than the version its APIs were read against", () => {
    // Narrower than pi-ask-popup's `>=0.80` on purpose. This package builds on
    // createAgentSession and AgentSession.getAvailableThinkingLevels, and both
    // were only ever audited against 0.84.4.
    const peers = readManifest().peerDependencies ?? {};
    expect(peers["@earendil-works/pi-coding-agent"]).toBe(">=0.84");
    expect(peers["@earendil-works/pi-tui"]).toBe(">=0.84");
  });

  it("does not peer pi-ai", () => {
    // getSupportedThinkingLevels lives in @earendil-works/pi-ai/compat, which
    // Pi keeps as a nested shrinkwrapped dependency and never re-exports.
    // Reaching into that tree would peer a package the host may not hoist. The
    // public route is AgentSession.getAvailableThinkingLevels().
    expect(readManifest().peerDependencies ?? {}).not.toHaveProperty("@earendil-works/pi-ai");
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

  it("publishes source and legal text, and nothing else", () => {
    const files = readManifest().files ?? [];
    expect(files).toContain("src/");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).not.toContain("test/");
  });

  it("is public, MIT, and starts at 0.1.0", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("pi-broodmother");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("carries one copyright holder, because this is not a fork", () => {
    // Nothing here is forked. Adding an upstream line would claim a lineage
    // that does not exist; if code is ever lifted from another project, this
    // assertion is the reminder that the line has to go in.
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    const holders = license.match(/^Copyright \(c\) .+$/gm) ?? [];
    expect(holders).toEqual(["Copyright (c) 2026 derangga"]);
  });
});
