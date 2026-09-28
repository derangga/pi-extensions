import { describe, expect, it } from "vitest";
import type { Jail, ReadyJail } from "../src/profile.js";
import { wrapCommand } from "../src/shell.js";

const shell = "/bin/bash";

function readyJail(): ReadyJail {
  return {
    state: "ready",
    backend: "sandbox-exec",
    launcher: "/usr/bin/sandbox-exec",
    args: ["-f", "/tmp/my profile.sb"],
    env: { HOME: "/tmp/home" },
    home: "/tmp/home",
    temporaryDirectory: "/tmp/temp",
    cleanupRoot: "/tmp/root",
    profilePath: "/tmp/my profile.sb",
  };
}

describe("wrapping a command", () => {
  it("runs the command through the ready backend", () => {
    const wrapped = wrapCommand(readyJail(), "npm test", shell);
    expect(wrapped).toBe(
      "'/usr/bin/sandbox-exec' '-f' '/tmp/my profile.sb' '/bin/bash' '-c' 'npm test'",
    );
  });

  it("escapes single quotes in the original command", () => {
    const wrapped = wrapCommand(readyJail(), "echo 'hello world'", shell);
    expect(wrapped.endsWith("'echo '\\''hello world'\\'''")).toBe(true);
  });

  it("fails closed without including the rejected command", () => {
    const jail: Jail = { state: "blocked", reason: "backend missing" };
    const wrapped = wrapCommand(jail, "curl https://attacker.invalid", shell);
    expect(wrapped).toContain("backend missing");
    expect(wrapped).toContain("exit 126");
    expect(wrapped).not.toContain("curl");
  });
});
