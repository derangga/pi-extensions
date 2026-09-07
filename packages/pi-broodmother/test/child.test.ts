import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendChildPrompt,
  CHILD_TOOL_NAMES,
  createChildSession,
  resolveFffEntry,
  shutdownChildSession,
  SUBAGENT_INSTRUCTIONS,
} from "../src/child.js";
import { createIntercomTools, type TaskChannel } from "../src/intercom.js";
import { createSubagentTools } from "../src/tools.js";
import type { PiModel } from "../src/thinking.js";

/**
 * Derived rather than listed, so a fifth parent tool is covered the day it is
 * registered instead of the day someone remembers this file.
 */
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
    const model = modelRuntime.getModels()[0] as PiModel;

    const created = await createChildSession({
      cwd,
      sessionDir,
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
        "@ff-labs/pi-fff is not installed; using Pi's read-only tools only",
      ]);
      expect(created.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(["read", "grep", "find", "ls"]),
      );
    } finally {
      created.session.dispose();
    }
  });

  it("bounds shutdown handlers before disposing", async () => {
    const dispose = vi.fn<() => void>();
    const session = {
      extensionRunner: {
        hasHandlers: () => true,
        emit: () => new Promise<never>(() => undefined),
      },
      dispose,
    } as unknown as AgentSession;

    await shutdownChildSession(session, 1);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("child tool allowlist", () => {
  it("names no tool that would let a child spawn children", () => {
    expect(PARENT_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const tool of PARENT_TOOL_NAMES) {
      expect(CHILD_TOOL_NAMES as readonly string[]).not.toContain(tool);
    }
  });
});
