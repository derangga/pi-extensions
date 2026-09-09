import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Manifest guard. Zero runtime dependencies is this package's identity: every
 * capability it needs comes from the Pi host as a peer dependency. A single
 * added dependency has to fail here rather than arrive unnoticed.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  version: string;
  license: string;
  type: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

function readManifest(): Manifest {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

describe("pi-todo-agent manifest", () => {
  it("ships zero runtime dependencies", () => {
    const manifest = readManifest();
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("declares exactly the three host-provided peers", () => {
    const peers = readManifest().peerDependencies ?? {};
    expect(Object.keys(peers).sort()).toEqual(
      ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].sort(),
    );
  });

  it("registers the extension entry the manifest ships", () => {
    const manifest = readManifest();
    const entry = manifest.pi?.extensions?.[0];
    expect(entry).toBe("./src/index.ts");
    expect(existsSync(join(packageRoot, entry ?? ""))).toBe(true);
  });
});
