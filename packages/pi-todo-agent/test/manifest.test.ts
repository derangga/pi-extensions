import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  files?: string[];
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

  it("ships every source module under the files globs", () => {
    // A module outside the files list publishes fine but is missing from the
    // tarball, so the installed extension cannot resolve it at runtime.
    const files = readManifest().files ?? [];
    const uncovered: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        const rel = relative(packageRoot, full);
        const covered = files.some(
          (pattern) => rel.startsWith(pattern.replace(/\/$/, "")) || rel === pattern,
        );
        if (!covered) {
          uncovered.push(rel);
        }
      }
    };
    walk(join(packageRoot, "src"));
    expect(uncovered).toEqual([]);
    expect(files).toContain("src/");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
  });
});
