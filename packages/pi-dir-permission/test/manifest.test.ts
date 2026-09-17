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
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  pi?: { extensions?: string[] };
}

function readManifest(): Manifest {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
}

describe("pi-dir-permission manifest", () => {
  it("ships zero runtime dependencies", () => {
    const manifest = readManifest();
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("declares exactly the two host-provided peers", () => {
    // No typebox: this extension registers no tools, so it never builds a schema.
    const peers = readManifest().peerDependencies ?? {};
    expect(Object.keys(peers).sort()).toEqual(
      ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"].sort(),
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

  it("keeps tests out of the tarball", () => {
    expect(readManifest().files ?? []).not.toContain("test/");
  });

  it("is public, MIT, and starts at 0.1.0", () => {
    // The version lives in three places at once: here, the manifest, and the
    // git tag. `npm run release` rewrites this assertion and this test's title
    // from one argument, and the publish workflow rejects a tag that disagrees
    // with the manifest. Editing any one of them by hand breaks that chain.
    const manifest = readManifest();
    expect(manifest.name).toBe("pi-dir-permission");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });
});
