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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadAgentFile", () => {
  it("loads only the exact safe name", async () => {
    const cwd = temporaryRoot("pi-broodmother-project-");
    const agentDir = temporaryRoot("pi-broodmother-global-");
    writeAgent(cwd, ".pi/agents", "researcher", "Project prompt");

    expect(await loadAgentFile("research", cwd, agentDir)).toBeUndefined();
    expect(await loadAgentFile("../researcher", cwd, agentDir)).toBeUndefined();
    expect((await loadAgentFile("researcher", cwd, agentDir))?.prompt).toBe("Project prompt");
  });

  it("uses project, shared workspace, then global precedence", async () => {
    const cwd = temporaryRoot("pi-broodmother-project-");
    const agentDir = temporaryRoot("pi-broodmother-global-");
    writeAgent(agentDir, "agents", "reviewer", "Global");
    writeAgent(cwd, ".agents/agents", "reviewer", "Shared");
    const project = writeAgent(cwd, ".pi/agents", "reviewer", "Project");

    expect(await loadAgentFile("reviewer", cwd, agentDir)).toMatchObject({
      path: project,
      prompt: "Project",
    });
  });

  it("returns model and supported thinking frontmatter", async () => {
    const cwd = temporaryRoot("pi-broodmother-project-");
    const agentDir = temporaryRoot("pi-broodmother-global-");
    writeAgent(
      cwd,
      ".pi/agents",
      "synthesizer",
      "---\nmodel: anthropic/claude-haiku\nthinking: high\n---\n\nSynthesize evidence.\n",
    );

    expect(await loadAgentFile("synthesizer", cwd, agentDir)).toMatchObject({
      prompt: "Synthesize evidence.",
      choice: { model: "anthropic/claude-haiku", thinking: "high" },
    });
  });

  it("drops an unknown thinking value without discarding the file", async () => {
    const cwd = temporaryRoot("pi-broodmother-project-");
    const agentDir = temporaryRoot("pi-broodmother-global-");
    writeAgent(cwd, ".pi/agents", "reader", "---\nthinking: enormous\n---\nRead.");

    expect(await loadAgentFile("reader", cwd, agentDir)).toMatchObject({
      prompt: "Read.",
      choice: {},
    });
  });
});
