import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockReason, inspectPath, promptNotice } from "../src/gate.js";
import { mergeLayers } from "../src/rules.js";

const home = homedir();
const cwd = "/repo";
const rules = mergeLayers({ global: {}, project: {}, projectTrusted: true });
const noExtras = new Map<string, string>();

describe("inspecting a path argument", () => {
  it("catches a gated tool reaching a gated path", () => {
    const request = inspectPath("read", ".env", rules, cwd, home, noExtras);
    expect(request?.rule.glob).toBe(".env");
    expect(request?.origin).toBe(".env");
  });

  it("normalizes Pi's leading-at path shorthand before matching", () => {
    expect(inspectPath("read", "@.env", rules, cwd, home, noExtras)?.rule.glob).toBe(".env");
  });

  it("blocks recursive content searches whose root contains a protected file", () => {
    const envRule = rules[0];
    if (envRule === undefined) {
      throw new Error("builtin .env rule is missing");
    }
    const protectedTargets = [{ path: join(cwd, ".env"), directory: false, rule: envRule }];
    expect(inspectPath("grep", ".", rules, cwd, home, noExtras, protectedTargets)?.rule.glob).toBe(
      ".env",
    );
    expect(
      inspectPath("grep", undefined, rules, cwd, home, noExtras, protectedTargets)?.rule.glob,
    ).toBe(".env");
    expect(
      inspectPath("ffgrep", "*.env", rules, cwd, home, noExtras, protectedTargets)?.rule.glob,
    ).toBe(".env");
  });

  it("reports an origin that matches a needle's origin", () => {
    expect(inspectPath("read", "nested/app/.env", rules, cwd, home, noExtras)?.origin).toBe(
      "nested/app/.env",
    );
  });

  it("lets an ungated tool through", () => {
    expect(inspectPath("ls", ".env", rules, cwd, home, noExtras)).toBeUndefined();
  });

  it("lets a gated tool through when no rule claims the path", () => {
    expect(inspectPath("read", "src/app.ts", rules, cwd, home, noExtras)).toBeUndefined();
  });

  it("lets a gated tool through when it names no path", () => {
    expect(inspectPath("read", undefined, rules, cwd, home, noExtras)).toBeUndefined();
    expect(inspectPath("read", "   ", rules, cwd, home, noExtras)).toBeUndefined();
  });

  it("gates a tool the config added", () => {
    const extras = new Map([["some_tool", "file_path"]]);
    expect(inspectPath("some_tool", ".env", rules, cwd, home, extras)?.rule.glob).toBe(".env");
  });

  it("checks the lexical name before following a symlink", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandboxing-gate-"));
    try {
      const destination = join(workspace, "ordinary.txt");
      writeFileSync(destination, "TOKEN=abcdefgh\n", "utf8");
      symlinkSync(destination, join(workspace, ".env"));
      const request = inspectPath("read", ".env", rules, workspace, home, noExtras);
      expect(request?.rule.glob).toBe(".env");
      expect(request?.origin).toBe(".env");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("what the model is told", () => {
  it("names the rule and forbids trying another route", () => {
    const request = inspectPath("read", ".env", rules, cwd, home, noExtras);
    if (request === undefined) {
      throw new Error("expected .env to be blocked");
    }
    const reason = blockReason(request);
    expect(reason).toContain(".env");
    expect(reason).toContain("Do not retry");
  });

  it("lists the rules and says the jail is on", () => {
    const notice = promptNotice(rules, "strict", "sandbox-exec");
    expect(notice).toContain("- .env");
    expect(notice).toContain("network access denied");
  });

  it("says plainly when there is no jail", () => {
    expect(promptNotice(rules, "strict", undefined)).toContain("shell commands are blocked");
  });

  it("warns that a placeholder is literal text", () => {
    expect(promptNotice(rules, "strict", "bwrap")).toContain(
      "writes the placeholder, not the secret",
    );
  });
});
