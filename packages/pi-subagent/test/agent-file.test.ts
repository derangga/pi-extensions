import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentFile } from "../src/agent-file.js";

const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function writeAgent(root: string, relativeDir: string, name: string, content: string): string {
  const directory = join(root, relativeDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadAgentFile", () => {
  it("loads only the exact safe name", () => {
    const cwd = temporaryRoot("pi-subagent-project-");
    const agentDir = temporaryRoot("pi-subagent-global-");
    writeAgent(cwd, ".pi/agents", "researcher", "Project prompt");

    expect(loadAgentFile("research", cwd, agentDir)).toBeUndefined();
    expect(loadAgentFile("../researcher", cwd, agentDir)).toBeUndefined();
    expect(loadAgentFile("researcher", cwd, agentDir)?.prompt).toBe("Project prompt");
  });

  it("uses project, shared workspace, then global precedence", () => {
    const cwd = temporaryRoot("pi-subagent-project-");
    const agentDir = temporaryRoot("pi-subagent-global-");
    writeAgent(agentDir, "agents", "reviewer", "Global");
    writeAgent(cwd, ".agents/agents", "reviewer", "Shared");
    const project = writeAgent(cwd, ".pi/agents", "reviewer", "Project");

    expect(loadAgentFile("reviewer", cwd, agentDir)).toMatchObject({
      path: project,
      prompt: "Project",
    });
  });

  it("returns model and supported thinking frontmatter", () => {
    const cwd = temporaryRoot("pi-subagent-project-");
    const agentDir = temporaryRoot("pi-subagent-global-");
    writeAgent(
      cwd,
      ".pi/agents",
      "synthesizer",
      "---\nmodel: anthropic/claude-haiku\nthinking: high\n---\n\nSynthesize evidence.\n",
    );

    expect(loadAgentFile("synthesizer", cwd, agentDir)).toMatchObject({
      prompt: "Synthesize evidence.",
      choice: { model: "anthropic/claude-haiku", thinking: "high" },
    });
  });

  it("drops an unknown thinking value without discarding the file", () => {
    const cwd = temporaryRoot("pi-subagent-project-");
    const agentDir = temporaryRoot("pi-subagent-global-");
    writeAgent(cwd, ".pi/agents", "reader", "---\nthinking: enormous\n---\nRead.");

    expect(loadAgentFile("reader", cwd, agentDir)).toMatchObject({
      prompt: "Read.",
      choice: {},
    });
  });
});
