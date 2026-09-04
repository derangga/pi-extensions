import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Every assertion here encodes a packaging decision that is
 * invisible at a glance and expensive to discover after publishing: a stray
 * runtime dependency, a missing attribution line, an entry point or a vendored
 * text file that does not ship.
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

describe("pi-unslop manifest", () => {
  it("ships zero runtime dependencies", () => {
    expect(readManifest().dependencies).toBeUndefined();
  });

  it("peers Pi alone", () => {
    // No TUI: the extension draws nothing. No typebox: it registers no tool.
    // A peer we do not use is a version constraint we inflict for free.
    const peers = readManifest().peerDependencies ?? {};
    expect(Object.keys(peers)).toEqual(["@earendil-works/pi-coding-agent"]);
    expect(peers["@earendil-works/pi-coding-agent"]).toBe(">=0.80");
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

  it("publishes source and legal text, and nothing else", () => {
    const files = readManifest().files ?? [];
    expect(files).toContain("src/");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).not.toContain("test/");
  });

  it("ships the vendored skill text alongside the entry point", () => {
    // index.ts reads this at load. Ship one without the other and the package
    // throws on the first session rather than at install time.
    expect(existsSync(join(packageRoot, "src/unslop.md"))).toBe(true);
    expect(readManifest().files ?? []).toContain("src/");
  });

  it("records the upstream commit the text was vendored from", () => {
    // The text diverged the moment we added a preamble. The commit says where
    // we branched, which is the only way a later reader can diff upstream.
    const text = readFileSync(join(packageRoot, "src/unslop.md"), "utf8");
    expect(text).toContain("github.com/cursor/plugins");
    expect(text).toContain("73f8be4");
  });

  it("is public, MIT, and starts at 0.1.0", () => {
    const manifest = readManifest();
    expect(manifest.name).toBe("pi-unslop");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("credits both copyright holders in LICENSE", () => {
    // MIT terms require the original notice to survive. Dropping the pstack
    // line would make the package unlicensed, not merely impolite.
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 Lauren Tan");
    expect(license).toContain("Copyright (c) 2026 derangga");
  });
});
