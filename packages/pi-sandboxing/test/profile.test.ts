import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBwrapArgs,
  buildJail,
  buildSbpl,
  denyTargets,
  jailCommand,
  pickBackend,
} from "../src/profile.js";
import { homeRules, mergeLayers } from "../src/rules.js";

const home = homedir();
const builtins = mergeLayers({ global: {}, project: {}, projectTrusted: true });

/** Everything is a directory unless a test says otherwise. */
const allDirectories = () => true;

describe("choosing a backend", () => {
  it("uses sandbox-exec on macOS when it is present", () => {
    expect(pickBackend("darwin", (file) => file === "/usr/bin/sandbox-exec")).toBe("sandbox-exec");
  });

  it("uses bwrap on Linux when it is present", () => {
    expect(pickBackend("linux", () => true)).toBe("bwrap");
  });

  it("has nothing to offer when the binary is missing", () => {
    expect(pickBackend("darwin", () => false)).toBeUndefined();
    expect(pickBackend("linux", () => false)).toBeUndefined();
  });

  it("has nothing to offer on an unsupported platform", () => {
    expect(pickBackend("win32", () => true)).toBeUndefined();
  });
});

describe("choosing what to deny", () => {
  it("takes the home credential directories and drops the trailing slash", () => {
    const targets = denyTargets(homeRules(builtins, home), home, allDirectories);
    expect(targets.map((target) => target.path)).toEqual([
      join(home, ".aws"),
      join(home, ".ssh"),
      join(home, ".gnupg"),
    ]);
  });

  it("marks a file target as a file, so bwrap can bind over it", () => {
    const rules = homeRules(
      mergeLayers({ global: { rules: ["~/.netrc-backup"] }, project: {}, projectTrusted: true }),
      home,
    );
    const targets = denyTargets(rules, home, () => false);
    expect(targets).toContainEqual({ path: join(home, ".netrc-backup"), directory: false });
  });

  it("skips a wildcard, because a kernel profile cannot express one honestly", () => {
    const wildcard = homeRules(
      mergeLayers({ global: { rules: ["~/secrets/*.pem"] }, project: {}, projectTrusted: true }),
      home,
    ).filter((rule) => rule.source === "global");
    expect(wildcard).toHaveLength(1);
    expect(denyTargets(wildcard, home, allDirectories)).toEqual([]);
  });

  it("resolves a symlinked target, because the kernel matches the real path", () => {
    // A macOS temp directory is handed out as /var/folders/... and really lives
    // under /private/var/folders/..., so an unresolved deny covers nothing.
    const scratch = mkdtempSync(join(tmpdir(), "pi-sandboxing-link-"));
    mkdirSync(join(scratch, "creds"));
    try {
      const rules = homeRules(
        mergeLayers({ global: { rules: ["~/creds/"] }, project: {}, projectTrusted: true }),
        scratch,
      ).filter((rule) => rule.source === "global");
      const targets = denyTargets(rules, scratch, allDirectories);
      expect(targets[0]?.path).toBe(join(realpathSync(scratch), "creds"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the macOS profile", () => {
  const targets = [
    { path: "/Users/you/.ssh", directory: true },
    { path: "/Users/you/.netrc", directory: false },
  ];
  const profile = buildSbpl(targets);

  it("imports the system profile rather than starting from deny default", () => {
    // (deny default) aborts the process: dyld needs more than is obvious.
    expect(profile).toContain('(import "/System/Library/Sandbox/Profiles/bsd.sb")');
    expect(profile).not.toContain("(deny default)");
  });

  it("allows execution and reads before denying anything", () => {
    const allowIndex = profile.indexOf("(allow file-read*)");
    const denyIndex = profile.indexOf("(deny file-read*");
    expect(allowIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeGreaterThan(allowIndex);
  });

  it("denies reads and writes of every target by subpath", () => {
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users/you/.ssh"))');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users/you/.netrc"))');
  });

  it("escapes a quote in a path rather than closing the string early", () => {
    expect(buildSbpl([{ path: '/Users/you/we"ird', directory: true }])).toContain(
      '(subpath "/Users/you/we\\"ird")',
    );
  });
});

describe("the Linux arguments", () => {
  const args = buildBwrapArgs([
    { path: "/home/you/.ssh", directory: true },
    { path: "/home/you/.netrc", directory: false },
  ]);

  it("shares the filesystem, then covers each denied path", () => {
    expect(args.slice(0, 2)).toEqual(["--dev-bind", "/"]);
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/home/you/.ssh");
    expect(args.join(" ")).toContain("--bind /dev/null /home/you/.netrc");
  });

  it("dies with the parent so no jailed process outlives the session", () => {
    expect(args).toContain("--die-with-parent");
  });
});

describe("building and running a jail", () => {
  it("has no jail to build when nothing is denied", () => {
    // Nothing to enforce means nothing to wrap, and one less thing to explain.
    expect(buildJail("sandbox-exec", [])).toBeUndefined();
  });

  it("wraps a command for sandbox-exec through a profile file", () => {
    const jail = buildJail("sandbox-exec", [{ path: "/Users/you/.ssh", directory: true }]);
    const invocation = jailCommand(jail, "/bin/bash", ["-c", "echo hi"]);
    expect(invocation?.file).toBe("/usr/bin/sandbox-exec");
    expect(invocation?.args.slice(0, 2)).toEqual(["-f", jail?.profilePath]);
    expect(invocation?.args.slice(2)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  it("wraps a command for bwrap with the arguments inline", () => {
    const jail = buildJail("bwrap", [{ path: "/home/you/.ssh", directory: true }]);
    const invocation = jailCommand(jail, "/bin/bash", ["-c", "echo hi"]);
    expect(invocation?.file).toBe("bwrap");
    expect(invocation?.args).toContain("--die-with-parent");
    expect(invocation?.args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  it("returns nothing to wrap when there is no jail", () => {
    expect(jailCommand(undefined, "/bin/bash", ["-c", "echo hi"])).toBeUndefined();
  });
});

describe("the macOS profile against the kernel", () => {
  // The one test that proves the generated text is a profile the OS accepts.
  // Everything above asserts strings; this runs sandbox-exec for real.
  it.skipIf(process.platform !== "darwin")("denies a real read and lets the rest work", () => {
    const secretRoot = mkdtempSync(join(tmpdir(), "pi-sandboxing-jail-"));
    writeFileSync(join(secretRoot, "key"), "hunter2supersecret\n", "utf8");
    // Resolved, as denyTargets would hand it over: the kernel matches real paths.
    const jail = buildJail("sandbox-exec", [{ path: realpathSync(secretRoot), directory: true }]);
    const invocation = jailCommand(jail, "/bin/sh", [
      "-c",
      `cat ${secretRoot}/key >/dev/null 2>&1 && echo LEAK || echo denied; echo alive`,
    ]);
    try {
      const output = execFileSync(invocation?.file ?? "", invocation?.args ?? [], {
        encoding: "utf8",
      });
      expect(output).toContain("denied");
      expect(output).toContain("alive");
      expect(output).not.toContain("LEAK");
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
      if (jail !== undefined) {
        rmSync(jail.profilePath, { force: true });
      }
    }
  });
});
