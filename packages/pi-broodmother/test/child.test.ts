import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendChildPrompt,
  CHILD_TOOL_NAMES,
  CHILD_TOOL_NAMES_READONLY,
  CHILD_TOOL_NAMES_READWRITE,
  childInstructions,
  createChildSession,
  resolveFffEntry,
  shutdownChildSession,
  SUBAGENT_INSTRUCTIONS,
  SUBAGENT_INSTRUCTIONS_READWRITE,
} from "../src/child.js";
import { createIntercomTools, type TaskChannel } from "../src/intercom.js";
import { createSubagentTools } from "../src/tools.js";
import type { PiModel } from "../src/thinking.js";

/**
 * Derived rather than listed, so a fifth parent tool is covered the day it is
 * registered instead of the day someone remembers this file.
 */
// SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
const PARENT_TOOL_NAMES = createSubagentTools({} as never).map((tool) => tool.name);

vi.setConfig({ testTimeout: 30_000 });

const fixture = resolve(fileURLToPath(new URL("./fixtures/lazy-fff.ts", import.meta.url)));
const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("child session", () => {
  it("resolves a file URL and degrades when fff is unavailable", () => {
    expect(resolveFffEntry(() => "file:///tmp/fff.ts")).toBe("/tmp/fff.ts");
    expect(
      resolveFffEntry(() => {
        throw new Error("missing");
      }),
    ).toBeUndefined();
  });

  it("appends the task prompt before the child instructions", () => {
    expect(appendChildPrompt(["base one", "base two"], "Investigate this.")).toEqual([
      "base one",
      "base two",
      `Investigate this.\n\n${SUBAGENT_INSTRUCTIONS}`,
    ]);
  });

  it("binds a lazy extension into a persisted read-only child", async () => {
    const cwd = temporaryRoot("pi-broodmother-child-");
    const sessionDir = temporaryRoot("pi-broodmother-sessions-");
    writeFileSync(join(cwd, "AGENTS.md"), "PARENT CONVENTIONS MUST NOT LOAD", "utf8");

    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const model = modelRuntime.getModels()[0] as PiModel | undefined;
    expect(model).toBeDefined();

    const intercom: TaskChannel = {
      ask: () => Effect.succeed("answer"),
      notify: () => Effect.void,
    };
    const created = await createChildSession({
      cwd,
      sessionDir,
      parentSession: "/tmp/parent-session.jsonl",
      projectTrusted: true,
      permissions: "read-only",
      name: "researcher",
      prompt: "Find the answer.",
      model: model!,
      thinking: "off",
      modelRuntime,
      fffEntry: fixture,
      customTools: createIntercomTools(intercom),
    });

    const emit = vi.spyOn(created.session.extensionRunner, "emit");
    try {
      expect(created.fffLoaded).toBe(true);
      expect(created.notes).toEqual([]);
      expect(created.session.sessionName).toBe("subagent: researcher");
      expect(created.session.systemPrompt).toContain("Find the answer.");
      expect(created.session.systemPrompt).toContain(SUBAGENT_INSTRUCTIONS);
      expect(created.session.systemPrompt).not.toContain("PARENT CONVENTIONS MUST NOT LOAD");

      const active = created.session.getActiveToolNames();
      expect(active).toContain("ffgrep");
      expect(active).toContain("ask_parent");
      expect(active).toContain("notify_parent");
      for (const tool of ["read", "grep", "find", "ls"]) {
        expect(active).toContain(tool);
      }
      for (const tool of ["bash", "edit", "write"]) {
        expect(active).not.toContain(tool);
      }
      expect(CHILD_TOOL_NAMES).toContain("fff-multi-grep");
      expect(CHILD_TOOL_NAMES).toContain("multi_grep");
      // A child that could reach these would spawn children of its own.
      for (const tool of PARENT_TOOL_NAMES) {
        expect(active).not.toContain(tool);
      }

      expect(created.sessionFile).toBeDefined();
      expect(created.session.sessionManager.getHeader()?.parentSession).toBe(
        "/tmp/parent-session.jsonl",
      );
    } finally {
      await shutdownChildSession(created.session);
    }
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("creates a usable built-in-only child when fff is absent", async () => {
    const cwd = temporaryRoot("pi-broodmother-child-");
    const sessionDir = temporaryRoot("pi-broodmother-sessions-");
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const model = modelRuntime.getModels()[0] as PiModel;

    const created = await createChildSession({
      cwd,
      sessionDir,
      projectTrusted: true,
      permissions: "read-only",
      name: "reader",
      prompt: "Read.",
      model,
      thinking: "off",
      modelRuntime,
      fffEntry: null,
    });
    try {
      expect(created.fffLoaded).toBe(false);
      expect(created.notes).toEqual([
        "@ff-labs/pi-fff is not installed; using Pi's built-in tools only",
      ]);
      expect(created.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(["read", "grep", "find", "ls"]),
      );
    } finally {
      created.session.dispose();
    }
  });

  it("loads a project skill only when the parent trusted the project", async () => {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const model = modelRuntime.getModels()[0] as PiModel;

    /** A skill directory shaped the way Pi's package manager discovers them. */
    const withSkill = (): string => {
      const cwd = temporaryRoot("pi-broodmother-skill-");
      const dir = join(cwd, ".agents", "skills", "spelunking");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: spelunking\ndescription: PROJECT SKILL MARKER\n---\n\nGo deep.\n",
        "utf8",
      );
      return cwd;
    };

    const open = async (cwd: string, projectTrusted: boolean) =>
      createChildSession({
        cwd,
        sessionDir: temporaryRoot("pi-broodmother-sessions-"),
        name: "spelunker",
        prompt: "Look around.",
        model,
        thinking: "off",
        permissions: "read-only",
        projectTrusted,
        modelRuntime,
        fffEntry: null,
      });

    const trusted = await open(withSkill(), true);
    try {
      expect(trusted.session.systemPrompt).toContain("PROJECT SKILL MARKER");
    } finally {
      trusted.session.dispose();
    }

    const untrusted = await open(withSkill(), false);
    try {
      expect(untrusted.session.systemPrompt).not.toContain("PROJECT SKILL MARKER");
    } finally {
      untrusted.session.dispose();
    }
  });

  it("hands a child edit, write and bash only when the run is read-write", async () => {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const model = modelRuntime.getModels()[0] as PiModel;

    const open = async (permissions: "read-only" | "read-write") =>
      createChildSession({
        cwd: temporaryRoot("pi-broodmother-mode-"),
        sessionDir: temporaryRoot("pi-broodmother-sessions-"),
        name: "implementer",
        prompt: "Land the change.",
        model,
        thinking: "off",
        permissions,
        projectTrusted: true,
        modelRuntime,
        fffEntry: null,
      });

    const writable = await open("read-write");
    try {
      const active = writable.session.getActiveToolNames();
      for (const tool of ["read", "grep", "find", "ls", "edit", "write", "bash"]) {
        expect(active).toContain(tool);
      }
      // Pi registers this on every platform; a child gets the parent's shell,
      // not one this package picked for it.
      expect(active).not.toContain("powershell");
      // Still no way to spawn children of its own, whatever else it can do.
      for (const tool of PARENT_TOOL_NAMES) {
        expect(active).not.toContain(tool);
      }
      expect(writable.session.systemPrompt).toContain(SUBAGENT_INSTRUCTIONS_READWRITE);
    } finally {
      writable.session.dispose();
    }

    const reader = await open("read-only");
    try {
      const active = reader.session.getActiveToolNames();
      for (const tool of ["edit", "write", "bash"]) {
        expect(active).not.toContain(tool);
      }
      expect(reader.session.systemPrompt).not.toContain(SUBAGENT_INSTRUCTIONS_READWRITE);
    } finally {
      reader.session.dispose();
    }
  });

  it("bounds shutdown handlers before disposing", async () => {
    const dispose = vi.fn<() => void>();
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const rawSession: unknown = {
      extensionRunner: {
        hasHandlers: () => true,
        emit: () => new Promise<never>(() => undefined),
      },
      dispose,
    };
    const session = rawSession as AgentSession;

    await shutdownChildSession(session, 1);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("child tool allowlist", () => {
  it("names no tool that would let a child spawn children, in either mode", () => {
    expect(PARENT_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const list of [CHILD_TOOL_NAMES_READONLY, CHILD_TOOL_NAMES_READWRITE]) {
      for (const tool of PARENT_TOOL_NAMES) {
        // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
        expect(list as readonly string[]).not.toContain(tool);
      }
    }
  });

  it("keeps the old name pointing at the read-only list", () => {
    expect(CHILD_TOOL_NAMES).toBe(CHILD_TOOL_NAMES_READONLY);
    // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
    const readonlyNames = CHILD_TOOL_NAMES_READONLY as readonly string[];
    for (const tool of ["edit", "write", "bash"]) {
      expect(readonlyNames).not.toContain(tool);
    }
  });

  it("adds exactly edit, write and bash on top of the read-only list", () => {
    expect(CHILD_TOOL_NAMES_READWRITE).toEqual([
      ...CHILD_TOOL_NAMES_READONLY,
      "edit",
      "write",
      "bash",
    ]);
  });

  it("branches the instruction text on the mode", () => {
    expect(childInstructions("read-only")).toContain("read-only");
    expect(childInstructions("read-write")).toContain("write access");
    // The shared half must not drift between the two.
    for (const mode of ["read-only", "read-write"] as const) {
      expect(childInstructions(mode)).toContain("ask_parent");
      expect(childInstructions(mode)).toContain("later dependency wave");
    }
  });
});
