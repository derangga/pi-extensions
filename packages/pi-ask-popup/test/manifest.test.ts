import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Every assertion here encodes a packaging decision that is
 * invisible at a glance and expensive to discover after publishing: a stray
 * runtime dependency, the wrong typebox package name, a missing attribution
 * line, an entry point that does not ship.
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

describe("pi-ask-popup manifest", () => {
  it("ships zero runtime dependencies", () => {
    // The whole premise of the fork over rpiv-ask-user-question, which pulls
    // @juicesharp/rpiv-config and typebox as hard dependencies.
    expect(readManifest().dependencies).toBeUndefined();
  });

  it("declares typebox, not @sinclair/typebox, as a peer", () => {
    // Pi 0.84.4 depends on `typebox@1.3.7`. The old `@sinclair/typebox` name is
    // a different package, and peering it resolves to something Pi never loads.
    const peers = readManifest().peerDependencies ?? {};
    expect(peers).toHaveProperty("typebox");
    expect(peers).not.toHaveProperty("@sinclair/typebox");
  });

  it("peers Pi at the range the .d.ts audit proved safe", () => {
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
    for (const target of Object.values(readManifest().exports ?? {})) {
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
    expect(manifest.name).toBe("pi-ask-popup");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("credits both copyright holders in LICENSE", () => {
    // MIT terms require the original notice to survive the fork. Dropping the
    // juicesharp line would make the package unlicensed, not merely impolite.
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 juicesharp");
    expect(license).toContain("Copyright (c) 2026 derangga");
  });
});
