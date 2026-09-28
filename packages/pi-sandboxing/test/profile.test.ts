import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBwrapArgs,
  buildJail,
  buildSbpl,
  cleanupJail,
  jailCommand,
  pickBackend,
  type Backend,
  type SandboxSpec,
} from "../src/profile.js";
import { mergeLayers } from "../src/rules.js";
import { discoverProtectedTargets } from "../src/targets.js";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

function spec(workspace: string): SandboxSpec {
  const rules = mergeLayers({ global: {}, project: {}, projectTrusted: true });
  return {
    workspace,
    commandCwd: workspace,
    shellPath: "/bin/sh",
    targets: [{ path: join(workspace, ".env"), directory: false }],
    rules,
    home: workspace,
    sourceEnvironment: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "must-not-pass" },
  };
}

describe("choosing a backend", () => {
  it("finds bwrap through PATH", () => {
    const bin = temporaryDirectory("pi-sandboxing-bin-");
    const executable = join(bin, "bwrap");
    writeFileSync(executable, "#!/bin/sh\n", "utf8");
    chmodSync(executable, 0o755);
    expect(pickBackend("linux", bin)).toEqual({ name: "bwrap", executable });
  });

  it("returns nothing for unsupported platforms", () => {
    expect(pickBackend("win32", "/usr/bin:/bin")).toBeUndefined();
  });
});

describe("the macOS profile", () => {
  it("imports the process baseline, then revokes network and broad filesystem access", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    const home = temporaryDirectory("pi-sandboxing-home-");
    const temporary = temporaryDirectory("pi-sandboxing-tmp-");
    const protectedParent = join(workspace, "config");
    const target = join(protectedParent, ".env");
    const profile = buildSbpl(
      workspace,
      home,
      temporary,
      ["/usr"],
      [{ path: target, directory: false }],
    );
    expect(profile).toContain("bsd.sb");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-read*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).not.toContain("(allow network*)");
    expect(profile).toContain(`(allow file-read* file-write* (subpath "${workspace}"))`);
    expect(profile).toContain(`(deny file-write* (literal "${protectedParent}"))`);
    expect(profile).not.toContain(`(deny file-write* (literal "${workspace}"))`);
    expect(profile).toContain(`(deny file-read* file-write* (literal "${target}"))`);
  });
});

describe("the Linux arguments", () => {
  it("uses namespaces, a synthetic root, read-only runtimes, and secret masks", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    const home = temporaryDirectory("pi-sandboxing-home-");
    const temporary = temporaryDirectory("pi-sandboxing-tmp-");
    const empty = temporaryDirectory("pi-sandboxing-empty-");
    const target = join(workspace, ".env");
    const args = buildBwrapArgs(
      workspace,
      workspace,
      home,
      temporary,
      empty,
      ["/usr"],
      [{ path: target, directory: false }],
      { HOME: home, PATH: "/usr/bin:/bin" },
    );
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--clearenv");
    expect(args.join(" ")).not.toContain("--dev-bind / /");
    expect(args.join(" ")).toContain(`--bind ${workspace} ${workspace}`);
    expect(args.join(" ")).toContain(`--ro-bind /dev/null ${target}`);
    expect(args.join(" ")).toContain("--ro-bind /etc/passwd /etc/passwd");
  });

  it("recreates runtime symlinks instead of canonicalizing away merged roots", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    const home = temporaryDirectory("pi-sandboxing-home-");
    const temporary = temporaryDirectory("pi-sandboxing-tmp-");
    const empty = temporaryDirectory("pi-sandboxing-empty-");
    const runtime = temporaryDirectory("pi-sandboxing-runtime-");
    const links = temporaryDirectory("pi-sandboxing-links-");
    const link = join(links, "bin");
    symlinkSync(runtime, link, "dir");
    const args = buildBwrapArgs(workspace, workspace, home, temporary, empty, [link], [], {
      HOME: home,
      PATH: link,
    });
    expect(args.join(" ")).toContain(`--symlink ${runtime} ${link}`);
  });
});

describe("building a jail", () => {
  it("fails closed without a backend", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    expect(buildJail(undefined, spec(workspace))).toEqual({
      state: "blocked",
      reason: "no supported OS sandbox backend is available",
    });
  });

  it("masks protected files exposed by a PATH runtime root", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    const runtime = temporaryDirectory("pi-sandboxing-runtime-");
    mkdirSync(join(runtime, "bin"));
    const credentials = join(runtime, "credentials.json");
    writeFileSync(credentials, '{"token":"abcdefgh"}\n', "utf8");
    const backend: Backend = { name: "bwrap", executable: "/bin/true" };
    const jail = buildJail(backend, {
      ...spec(workspace),
      sourceEnvironment: { PATH: join(runtime, "bin") },
    });
    expect(jail.state).toBe("ready");
    if (jail.state !== "ready") {
      return;
    }
    expect(jail.args.join(" ")).toContain(`--ro-bind /dev/null ${realpathSync(credentials)}`);
    cleanupJail(jail);
  });

  it("creates and cleans session-owned resources", () => {
    const workspace = temporaryDirectory("pi-sandboxing-workspace-");
    writeFileSync(join(workspace, ".env"), "TOKEN=abcdefgh\n", "utf8");
    const backend: Backend = { name: "bwrap", executable: "/bin/true" };
    const jail = buildJail(backend, spec(workspace));
    expect(jail.state).toBe("ready");
    if (jail.state !== "ready") {
      return;
    }
    expect(jail.env["SECRET_TOKEN"]).toBeUndefined();
    expect(existsSync(jail.cleanupRoot)).toBe(true);
    cleanupJail(jail);
    expect(existsSync(jail.cleanupRoot)).toBe(false);
  });
});

describe("the real macOS backend", () => {
  it.skipIf(process.platform !== "darwin")(
    "allows workspace work while denying secrets, host files, and environment",
    async () => {
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      if (address === null || typeof address === "string") {
        listener.close();
        throw new Error("local test listener has no TCP port");
      }
      const workspace = temporaryDirectory("pi-sandboxing-real-workspace-");
      const outside = temporaryDirectory("pi-sandboxing-real-outside-");
      const secret = join(workspace, ".env");
      const protectedParent = join(workspace, "config");
      const hostFile = join(outside, "host-secret");
      mkdirSync(protectedParent);
      writeFileSync(secret, "TOKEN=abcdefgh\n", "utf8");
      writeFileSync(join(protectedParent, ".env"), "TOKEN=nestedsecret\n", "utf8");
      writeFileSync(join(workspace, "ordinary.txt"), "ordinary\n", "utf8");
      writeFileSync(hostFile, "host-secret\n", "utf8");
      const rules = mergeLayers({ global: {}, project: {}, projectTrusted: true });
      const backend: Backend = {
        name: "sandbox-exec",
        executable: "/usr/bin/sandbox-exec",
      };
      const jail = buildJail(backend, {
        workspace,
        commandCwd: workspace,
        shellPath: "/bin/sh",
        targets: discoverProtectedTargets(workspace, rules, workspace),
        rules,
        home: workspace,
        sourceEnvironment: {
          PATH: "/usr/bin:/bin",
          HOST_SECRET: "must-not-pass",
        },
      });
      expect(jail.state).toBe("ready");
      if (jail.state !== "ready") {
        listener.close();
        return;
      }
      const command = [
        "cat ordinary.txt",
        "printf created > created.txt",
        "test ! -r .env && echo secret-denied",
        "mv config moved >/dev/null 2>&1 && echo rename-open || echo rename-denied",
        "printf nested > config/new && echo nested-write",
        `cat '${hostFile}' >/dev/null 2>&1 && echo host-readable || echo host-denied`,
        'test -z "$HOST_SECRET" && echo env-clean',
        `test "$HOME" = '${jail.home}' && echo home-clean`,
        'printf home > "$HOME/probe"',
        `/usr/bin/nc -z 127.0.0.1 ${address.port} >/dev/null 2>&1 && echo network-open || echo network-denied`,
      ].join("; ");
      const invocation = jailCommand(jail, "/bin/sh", ["-c", command]);
      try {
        const output = execFileSync(invocation?.file ?? "", invocation?.args ?? [], {
          cwd: workspace,
          env: jail.env,
          encoding: "utf8",
        });
        expect(output).toContain("ordinary");
        expect(output).toContain("secret-denied");
        expect(output).toContain("rename-denied");
        expect(output).not.toContain("rename-open");
        expect(output).toContain("nested-write");
        expect(output).toContain("host-denied");
        expect(output).not.toContain("host-readable");
        expect(output).toContain("env-clean");
        expect(output).toContain("home-clean");
        expect(output).toContain("network-denied");
        expect(output).not.toContain("network-open");
        expect(existsSync(join(workspace, "created.txt"))).toBe(true);
        expect(existsSync(join(jail.home, "probe"))).toBe(true);
      } finally {
        listener.close();
        cleanupJail(jail);
      }
    },
  );
});
