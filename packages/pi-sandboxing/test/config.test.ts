import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, loadConfig } from "../src/config.js";

let agentDir = "";
let projectDir = "";

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-sandboxing-agent-"));
  projectDir = mkdtempSync(join(tmpdir(), "pi-sandboxing-project-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeGlobal(contents: string): void {
  writeFileSync(join(agentDir, CONFIG_FILE_NAME), contents, "utf8");
}

function writeProject(contents: string): void {
  writeFileSync(join(projectDir, CONFIG_FILE_NAME), contents, "utf8");
}

describe("defaults", () => {
  it("needs no file at all", () => {
    const { config, warnings } = loadConfig(agentDir, projectDir);
    expect(config.enabled).toBe(true);
    expect(config.global).toEqual({ rules: [], unguard: [] });
    expect(config.stoplist.size).toBe(0);
    expect(config.gatedTools.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("never creates a file by reading one", () => {
    loadConfig(agentDir, projectDir);
    expect(() => loadConfig(agentDir, projectDir)).not.toThrow();
  });
});

describe("the global layer", () => {
  it("reads rules, unguard, stoplist and gated tools", () => {
    writeGlobal(
      JSON.stringify({
        rules: ["*.jks"],
        unguard: [".npmrc"],
        stoplist: ["mycompany"],
        gatedTools: { some_tool: "file_path" },
      }),
    );
    const { config } = loadConfig(agentDir, projectDir);
    expect(config.global).toEqual({ rules: ["*.jks"], unguard: [".npmrc"] });
    expect(config.stoplist.has("mycompany")).toBe(true);
    expect(config.gatedTools.get("some_tool")).toBe("file_path");
  });

  it("is the only layer that can turn the extension off", () => {
    writeGlobal(JSON.stringify({ enabled: false }));
    expect(loadConfig(agentDir, projectDir).config.enabled).toBe(false);
  });
});

describe("the project layer", () => {
  it("adds rules, stoplist words and gated tools", () => {
    writeProject(
      JSON.stringify({
        rules: ["secrets/**"],
        stoplist: ["projectword"],
        gatedTools: { project_tool: "target" },
      }),
    );
    const { config } = loadConfig(agentDir, projectDir);
    expect(config.project).toEqual({ rules: ["secrets/**"], unguard: [] });
    expect(config.stoplist.has("projectword")).toBe(true);
    expect(config.gatedTools.get("project_tool")).toBe("target");
  });

  it("cannot unguard a builtin", () => {
    writeProject(JSON.stringify({ unguard: [".env"] }));
    expect(loadConfig(agentDir, projectDir).config.project.unguard).toEqual([]);
  });

  it("cannot turn the extension off", () => {
    // Otherwise cloning a repository would be enough to disable the sandbox.
    writeProject(JSON.stringify({ enabled: false }));
    expect(loadConfig(agentDir, projectDir).config.enabled).toBe(true);
  });

  it("is absent entirely for an untrusted checkout", () => {
    writeProject(JSON.stringify({ rules: ["secrets/**"] }));
    const { config } = loadConfig(agentDir, undefined);
    expect(config.project).toEqual({ rules: [], unguard: [] });
  });
});

describe("a malformed file", () => {
  it("degrades to defaults and says which file was wrong", () => {
    writeGlobal("{ not json");
    const { config, warnings } = loadConfig(agentDir, projectDir);
    expect(config.enabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(CONFIG_FILE_NAME);
  });

  it("ignores a key of the wrong type rather than failing the session", () => {
    // A session that cannot start is worse than one rule that was dropped.
    writeGlobal(JSON.stringify({ rules: "not-an-array", stoplist: 7, enabled: "yes" }));
    const { config, warnings } = loadConfig(agentDir, projectDir);
    expect(config.global.rules).toEqual([]);
    expect(config.stoplist.size).toBe(0);
    expect(config.enabled).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("drops a non-string entry inside an array", () => {
    writeGlobal(JSON.stringify({ rules: ["*.jks", 42, null] }));
    expect(loadConfig(agentDir, projectDir).config.global.rules).toEqual(["*.jks"]);
  });

  it("lowercases stoplist words so matching can ignore case", () => {
    writeGlobal(JSON.stringify({ stoplist: ["MyCompany"] }));
    expect(loadConfig(agentDir, projectDir).config.stoplist.has("mycompany")).toBe(true);
  });
});
