import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { blockReason, boundaryNotice, inspectToolCall } from "../src/gate.js";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "dir-permission-gate-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "dir-permission-outside-")));
const roots = [workspace];
const noExtraTools: ReadonlyMap<string, string> = new Map();

function call(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  // SAFETY: test fixture with the shape the runtime hands the handler.
  return { type: "tool_call", toolCallId: "t1", toolName, input } as ToolCallEvent;
}

function inspect(event: ToolCallEvent, allowed: readonly string[] = roots) {
  return inspectToolCall(event, workspace, allowed, homedir(), noExtraTools);
}

describe("inspectToolCall", () => {
  it("passes a path inside the workspace", () => {
    expect(inspect(call("read", { path: "src/index.ts" }))).toBeUndefined();
    expect(inspect(call("read", { path: join(workspace, "src", "index.ts") }))).toBeUndefined();
  });

  it("stops a built-in file tool reaching outside", () => {
    const request = inspect(call("read", { path: join(outside, "secrets.env") }));
    expect(request?.target).toBe(join(outside, "secrets.env"));
    expect(request?.scopes.dir).toBe(outside);
  });

  it("stops every built-in that takes a path", () => {
    for (const toolName of ["read", "edit", "write", "ls", "grep", "find"]) {
      expect(inspect(call(toolName, { path: outside }))?.toolName).toBe(toolName);
    }
  });

  it("stops fff under both its default and override names", () => {
    for (const toolName of ["ffgrep", "fffind", "grep", "find"]) {
      expect(inspect(call(toolName, { pattern: "token", path: `${outside}/**` }))).toBeDefined();
    }
  });

  it("lets fff search the workspace with a repo-relative constraint", () => {
    // fff's `path` is a constraint, not always a path. Resolving these would
    // gate searches that never leave the workspace.
    expect(inspect(call("ffgrep", { pattern: "token", path: "src/**/*.ts" }))).toBeUndefined();
    expect(inspect(call("fffind", { pattern: "main", path: "main.rs" }))).toBeUndefined();
  });

  it("ignores a call with no path at all", () => {
    expect(inspect(call("ls", {}))).toBeUndefined();
    expect(inspect(call("ffgrep", { pattern: "token" }))).toBeUndefined();
    expect(inspect(call("read", { path: "   " }))).toBeUndefined();
  });

  it("leaves the shell alone", () => {
    // Documented hole: a shell command is a string, and this is a workspace
    // boundary rather than a security boundary.
    expect(inspect(call("bash", { command: `cat ${outside}/secrets.env` }))).toBeUndefined();
    expect(inspect(call("powershell", { command: `type ${outside}` }))).toBeUndefined();
  });

  it("ignores tools it was never told about", () => {
    expect(inspect(call("some_extension_tool", { path: outside }))).toBeUndefined();
  });

  it("gates an extra tool named in config, on its own argument", () => {
    const extra: ReadonlyMap<string, string> = new Map([["some_extension_tool", "file_path"]]);
    const event = call("some_extension_tool", { file_path: join(outside, "a.txt") });
    expect(inspectToolCall(event, workspace, roots, homedir(), extra)).toBeDefined();
    expect(inspectToolCall(event, workspace, roots, homedir(), noExtraTools)).toBeUndefined();
  });

  it("passes once the directory has been granted", () => {
    const event = call("read", { path: join(outside, "notes.md") });
    expect(inspect(event)).toBeDefined();
    expect(inspect(event, [workspace, outside])).toBeUndefined();
  });

  it("catches a symlink inside the workspace that points out of it", () => {
    // The whole reason comparisons run on resolved paths: this path looks like
    // it is inside the workspace and is not.
    symlinkSync(outside, join(workspace, "escape"));
    const request = inspect(call("read", { path: "escape/secrets.env" }));
    expect(request?.target).toBe(join(outside, "secrets.env"));
  });
});

describe("blockReason", () => {
  it("names the path and the way forward", () => {
    const request = inspect(call("read", { path: join(outside, "a.txt") }));
    expect(request).toBeDefined();
    if (!request) {
      return;
    }
    expect(blockReason(request, true)).toContain("The user declined");
    expect(blockReason(request, false)).toContain("/dir-perm-add");
    expect(blockReason(request, true)).toContain(request.target);
  });
});

describe("boundaryNotice", () => {
  it("lists every allowed root for the model", () => {
    const notice = boundaryNotice([workspace, outside]);
    expect(notice).toContain(`- ${workspace}`);
    expect(notice).toContain(`- ${outside}`);
    expect(notice).toContain("shell is not confined");
  });
});
