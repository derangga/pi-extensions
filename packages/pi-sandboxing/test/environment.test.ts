import { describe, expect, it } from "vitest";
import { buildStrictEnvironment } from "../src/environment.js";

describe("strict environment", () => {
  it("starts from an allowlist instead of copying the host environment", () => {
    const result = buildStrictEnvironment(
      {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        API_TOKEN: "super-secret-token",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        PI_SESSION_FILE: "/tmp/session.jsonl",
      },
      "/sandbox/home",
      "/sandbox/tmp",
      "/bin/sh",
      "/workspace",
    );
    expect(result.env).toMatchObject({
      HOME: "/sandbox/home",
      TMPDIR: "/sandbox/tmp",
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
    });
    expect(result.env["API_TOKEN"]).toBeUndefined();
    expect(result.env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(result.env["PI_SESSION_FILE"]).toBeUndefined();
    expect(result.env["PATH"]).toContain("/workspace/node_modules/.bin");
  });

  it("never widens home bin directories to credential-bearing parents", () => {
    const result = buildStrictEnvironment(
      {
        PATH: "/Users/you/bin:/Users/you/.local/bin:/Users/you/.cargo/bin",
        HOME: "/Users/you",
      },
      "/sandbox/home",
      "/sandbox/tmp",
      "/bin/sh",
      "/workspace",
    );
    expect(result.runtimeRoots).toEqual(
      expect.arrayContaining(["/Users/you/bin", "/Users/you/.local/bin", "/Users/you/.cargo/bin"]),
    );
    expect(result.runtimeRoots).not.toContain("/Users/you");
    expect(result.runtimeRoots).not.toContain("/Users/you/.local");
    expect(result.runtimeRoots).not.toContain("/Users/you/.cargo");
  });

  it("keeps known version-manager layouts together", () => {
    const installation = "/Users/you/.local/share/fnm/node-versions/v22.21.1/installation";
    const result = buildStrictEnvironment(
      { PATH: `${installation}/bin`, HOME: "/Users/you" },
      "/sandbox/home",
      "/sandbox/tmp",
      "/bin/sh",
      "/workspace",
    );
    expect(result.runtimeRoots).toContain(installation);
  });

  it("drops unsafe home-directory PATH entries", () => {
    const result = buildStrictEnvironment(
      { PATH: "/Users/you:/Users/you/private-tools", HOME: "/Users/you" },
      "/sandbox/home",
      "/sandbox/tmp",
      "/bin/sh",
      "/workspace",
    );
    expect(result.env["PATH"]).not.toContain("/Users/you/private-tools");
    expect(result.runtimeRoots).not.toContain("/Users/you");
  });
});
