import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPath } from "../src/gate.js";
import { mergeLayers } from "../src/rules.js";
import { discoverExplicitTargets, discoverProtectedTargets } from "../src/targets.js";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "pi-sandboxing-targets-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const rules = mergeLayers({ global: {}, project: {}, projectTrusted: true });

describe("protected target discovery", () => {
  it("invalidates cached entries when a nested directory changes", () => {
    const nested = join(workspace, "nested");
    mkdirSync(nested);
    expect(discoverProtectedTargets(workspace, rules, workspace, false)).toEqual([]);
    const secret = join(nested, ".env");
    writeFileSync(secret, "TOKEN=abcdefgh\n", "utf8");
    expect(discoverProtectedTargets(workspace, rules, workspace, false)).toContainEqual({
      path: secret,
      directory: false,
      rule: { glob: ".env", source: "builtin" },
    });
  });

  it("includes protected files and hard-link aliases", () => {
    const secret = join(workspace, ".env");
    const alias = join(workspace, "ordinary.txt");
    writeFileSync(secret, "TOKEN=abcdefgh\n", "utf8");
    linkSync(secret, alias);
    const targets = discoverProtectedTargets(workspace, rules, workspace);
    const paths = targets.map((target) => target.path);
    expect(paths).toContain(secret);
    expect(paths).toContain(alias);
    expect(
      inspectPath("read", alias, rules, workspace, workspace, new Map(), targets)?.rule.glob,
    ).toBe(".env");
  });

  it("masks host Unix sockets found inside the workspace", async () => {
    const socket = join(workspace, "host.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const target = discoverProtectedTargets(workspace, rules, workspace).find(
        (candidate) => candidate.path === socket,
      );
      expect(target).toEqual({ path: socket, directory: false });
    } finally {
      server.close();
    }
  });

  it("finds an explicit absolute target under a visible runtime root", () => {
    const secret = join(workspace, "host-secret.txt");
    writeFileSync(secret, "TOKEN=abcdefgh\n", "utf8");
    expect(
      discoverExplicitTargets([{ glob: secret, source: "global" }], workspace, [workspace]),
    ).toContainEqual({
      path: secret,
      directory: false,
      rule: { glob: secret, source: "global" },
    });
  });

  it("blocks a workspace hard link to a protected external file", () => {
    const protectedRoot = mkdtempSync(join(tmpdir(), "pi-sandboxing-external-"));
    try {
      const secret = join(protectedRoot, "secret.txt");
      const alias = join(workspace, "ordinary.txt");
      writeFileSync(secret, "TOKEN=abcdefgh\n", "utf8");
      linkSync(secret, alias);
      const rule = { glob: `${protectedRoot}/`, source: "global" } as const;
      expect(discoverProtectedTargets(workspace, [rule], workspace)).toContainEqual({
        path: alias,
        directory: false,
        rule,
      });
    } finally {
      rmSync(protectedRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "masks an unreadable subtree instead of aborting discovery",
    () => {
      const unreadable = join(workspace, "unreadable");
      mkdirSync(unreadable);
      writeFileSync(join(unreadable, ".env"), "TOKEN=abcdefgh\n", "utf8");
      chmodSync(unreadable, 0o000);
      try {
        expect(discoverProtectedTargets(workspace, rules, workspace, false)).toContainEqual({
          path: unreadable,
          directory: true,
        });
      } finally {
        chmodSync(unreadable, 0o700);
      }
    },
  );

  it("ignores an unprotected dangling runtime symlink", () => {
    const link = join(workspace, "missing-tool");
    symlinkSync(join(workspace, "missing-target"), link);
    expect(discoverProtectedTargets(workspace, rules, workspace, false)).not.toContainEqual(
      expect.objectContaining({ path: link }),
    );
  });

  it("protects the destination of a rule-matching symlink", () => {
    const destination = join(workspace, "ordinary.txt");
    const secretLink = join(workspace, ".env");
    writeFileSync(destination, "TOKEN=abcdefgh\n", "utf8");
    symlinkSync(destination, secretLink);
    const paths = discoverProtectedTargets(workspace, rules, workspace).map(
      (target) => target.path,
    );
    expect(paths).toContain(secretLink);
    expect(paths).toContain(destination);
  });
});
