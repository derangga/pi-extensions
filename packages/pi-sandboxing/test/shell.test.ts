import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildJail } from "../src/profile.js";
import { wrapCommand } from "../src/shell.js";

const shell = "/bin/bash";

function macJail(path: string) {
  return buildJail("sandbox-exec", [{ path, directory: true }]);
}

describe("wrapping a command", () => {
  it("returns the command untouched when there is no jail", () => {
    expect(wrapCommand(undefined, "npm test", shell)).toBe("npm test");
  });

  it("runs the command through sandbox-exec under the session profile", () => {
    const jail = macJail("/Users/you/.ssh");
    const wrapped = wrapCommand(jail, "npm test", shell);
    expect(wrapped.startsWith(`/usr/bin/sandbox-exec '-f' '${jail?.profilePath}'`)).toBe(true);
    expect(wrapped).toContain(`'${shell}' '-c' 'npm test'`);
    rmSync(jail?.profilePath ?? "", { force: true });
  });

  it("escapes single quotes so a quoted command survives the extra shell", () => {
    const jail = macJail("/Users/you/.ssh");
    const wrapped = wrapCommand(jail, "echo 'hello world'", shell);
    // The only way out of a single-quoted string is to close it, escape the
    // quote, and reopen: 'echo '\''hello world'\'''
    expect(wrapped.endsWith("'echo '\\''hello world'\\'''")).toBe(true);
    rmSync(jail?.profilePath ?? "", { force: true });
  });

  it("quotes a profile path containing a space", () => {
    const jail = {
      backend: "sandbox-exec" as const,
      profilePath: "/tmp/my dir/p.sb",
      args: ["-f", "/tmp/my dir/p.sb"],
    };
    expect(wrapCommand(jail, "ls", shell)).toContain("'-f' '/tmp/my dir/p.sb'");
  });

  it("runs the command through bwrap on Linux", () => {
    const jail = buildJail("bwrap", [{ path: "/home/you/.ssh", directory: true }]);
    const wrapped = wrapCommand(jail, "npm test", shell);
    expect(wrapped.startsWith("bwrap '--dev-bind' '/' '/' '--die-with-parent'")).toBe(true);
    expect(wrapped).toContain("'--tmpfs' '/home/you/.ssh'");
    expect(wrapped).toContain(`'${shell}' '-c' 'npm test'`);
  });
});

describe("the wrapped command against a real shell", () => {
  it.skipIf(process.platform !== "darwin")(
    "denies the jailed path and runs everything else",
    () => {
      // The host runs `shell -c <command>`, so this runs the wrapped string the
      // same way and proves the nesting and the quoting both survive.
      const secrets = mkdtempSync(join(tmpdir(), "pi-sandboxing-shell-"));
      writeFileSync(join(secrets, "key"), "hunter2supersecret\n", "utf8");
      const jail = macJail(realpathSync(secrets));
      const command = `cat '${secrets}/key' 2>/dev/null && echo LEAK || echo denied; echo 'still here'`;
      try {
        const output = execFileSync("/bin/bash", ["-c", wrapCommand(jail, command, shell)], {
          encoding: "utf8",
        });
        expect(output).toContain("denied");
        expect(output).toContain("still here");
        expect(output).not.toContain("LEAK");
        expect(output).not.toContain("hunter2supersecret");
      } finally {
        rmSync(secrets, { recursive: true, force: true });
        rmSync(jail?.profilePath ?? "", { force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")("leaves an unjailed path readable", () => {
    const secrets = mkdtempSync(join(tmpdir(), "pi-sandboxing-shell-"));
    const other = mkdtempSync(join(tmpdir(), "pi-sandboxing-open-"));
    writeFileSync(join(other, "note"), "ordinary content\n", "utf8");
    const jail = macJail(realpathSync(secrets));
    try {
      const output = execFileSync(
        "/bin/bash",
        ["-c", wrapCommand(jail, `cat '${other}/note'`, shell)],
        { encoding: "utf8" },
      );
      expect(output).toContain("ordinary content");
    } finally {
      rmSync(secrets, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(jail?.profilePath ?? "", { force: true });
    }
  });
});
