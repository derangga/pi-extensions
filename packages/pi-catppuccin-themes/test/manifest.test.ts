import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Every assertion here encodes a packaging decision that is
 * invisible at a glance and expensive to discover after publishing: a stray
 * dependency, a theme entry that does not ship, a missing attribution line.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  pi?: { extensions?: string[]; themes?: string[] };
  publishConfig?: { access?: string };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

describe("pi-catppuccin-themes manifest", () => {
  it("ships zero runtime dependencies", () => {
    expect(readManifest().dependencies).toBeUndefined();
  });

  it("declares no peers", () => {
    // A themes package ships data, not code. Nothing is imported, so there is
    // nothing to peer: Pi reads the JSON files through the pi.themes key.
    // In particular not the Pi packages, and not typebox, which is only for
    // extensions that register tools.
    expect(readManifest().peerDependencies).toBeUndefined();
  });

  it("points pi.themes at the four flavor files, all on disk", () => {
    const entries = readManifest().pi?.themes ?? [];
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.endsWith(".json")).toBe(true);
      expect(existsSync(join(packageRoot, entry))).toBe(true);
    }
  });

  it("publishes the themes, the README and the legal text, and nothing else", () => {
    const files = readManifest().files ?? [];
    expect(files).toContain("themes/");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).not.toContain("test/");
    expect(files).not.toContain("src/");
  });

  it("is public, MIT, and starts at 0.1.0", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("pi-catppuccin-themes");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("credits the origin of the port in LICENSE", () => {
    // The theme files are ported from another MIT-licensed package, so the
    // origin has to survive in the legal text. Dropping the line would make
    // the package unlicensed, not merely impolite.
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 derangga");
    expect(license).toContain("pi-coding-agent-catppuccin");
    expect(license).toContain("https://catppuccin.com");
  });
});
