import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockReason, inspectPath, promptNotice, scanCommand } from "../src/gate.js";
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
});

describe("scanning a shell command", () => {
  it("catches a plain read of a gated file", () => {
    expect(scanCommand("cat .env", rules, cwd, home)?.origin).toBe(".env");
  });

  it("catches a copy out of the workspace", () => {
    expect(scanCommand("cp .env /tmp/stash", rules, cwd, home)?.origin).toBe(".env");
  });

  it("catches a gated path anywhere in a pipeline", () => {
    expect(scanCommand("grep -h TOKEN < .env | sort", rules, cwd, home)?.origin).toBe(".env");
  });

  it("catches a home credential by absolute path", () => {
    expect(scanCommand(`cat ${join(home, ".ssh/known_hosts")}`, rules, cwd, home)?.rule.glob).toBe(
      "~/.ssh/",
    );
  });

  it("leaves an ordinary command alone", () => {
    expect(scanCommand("npm test -- --watch=false", rules, cwd, home)).toBeUndefined();
    expect(scanCommand("git commit -m 'update the env docs'", rules, cwd, home)).toBeUndefined();
  });

  it("still catches a path inside command substitution, because the split breaks on parens", () => {
    expect(scanCommand("cat $(echo .env)", rules, cwd, home)?.origin).toBe(".env");
  });

  it("catches an assignment, because the split breaks on equals too", () => {
    expect(scanCommand("SECRET=.env; cat $SECRET", rules, cwd, home)?.origin).toBe(".env");
  });

  it("loses to a variable set in an earlier command, which the redactor then covers", () => {
    // The honest limit. $SECRET is not a path here and never will be.
    expect(scanCommand("cat $SECRET", rules, cwd, home)).toBeUndefined();
  });

  it("ignores flags", () => {
    expect(scanCommand("ls -la", rules, cwd, home)).toBeUndefined();
  });
});

describe("what the model is told", () => {
  it("names the rule and forbids trying another route", () => {
    const request = inspectPath("read", ".env", rules, cwd, home, noExtras);
    const reason = blockReason(request!);
    expect(reason).toContain(".env");
    expect(reason).toContain("ask the user");
  });

  it("lists the rules and says the jail is on", () => {
    const notice = promptNotice(rules, true);
    expect(notice).toContain("- .env");
    expect(notice).toContain("denied to the shell by the operating system");
  });

  it("says plainly when there is no jail", () => {
    expect(promptNotice(rules, false)).toContain("No OS-level jail is active");
  });

  it("warns that a placeholder is literal text", () => {
    expect(promptNotice(rules, true)).toContain("writes the placeholder, not the secret");
  });
});
