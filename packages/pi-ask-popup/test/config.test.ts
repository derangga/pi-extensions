import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLAPSE_KEY_OFF,
  CONFIG_FILE_NAME,
  configPaths,
  DEFAULT_COLLAPSE_KEY,
  formatKeySpecForDisplay,
  loadConfig,
  resolveCollapseKey,
  validateGuidanceFields,
} from "../src/config.js";

/**
 * The loader takes its directories as arguments, so these tests point it at a
 * temp dir instead of mutating HOME. Upstream could not: its path resolved at
 * import time, and its own test says so in a comment while working around it.
 */
const roots: string[] = [];

function makeRoot(): { agentDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-ask-popup-config-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const projectDir = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
  return { agentDir, projectDir };
}

function writeGlobal(agentDir: string, body: string): void {
  writeFileSync(join(agentDir, CONFIG_FILE_NAME), body);
}

function writeProject(projectDir: string, body: string): void {
  writeFileSync(join(projectDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), body);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configPaths", () => {
  it("puts the global layer in the agent dir", () => {
    expect(configPaths({ agentDir: "/agent" })).toEqual([join("/agent", CONFIG_FILE_NAME)]);
  });

  it("adds the project layer after the global one, so it wins the merge", () => {
    expect(configPaths({ agentDir: "/agent", projectDir: "/ws" })).toEqual([
      join("/agent", CONFIG_FILE_NAME),
      join("/ws", CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    ]);
  });

  it("builds the project path from CONFIG_DIR_NAME rather than a hardcoded .pi", () => {
    // Rebranded distributions ship a different directory name.
    const [, project] = configPaths({ agentDir: "/agent", projectDir: "/ws" });
    expect(project).toContain(`${CONFIG_DIR_NAME}${"/"}`);
  });
});

describe("loadConfig", () => {
  it("returns empty defaults and no warnings when nothing is on disk", () => {
    const { agentDir } = makeRoot();
    expect(loadConfig({ agentDir })).toEqual({ config: {}, warnings: [] });
  });

  it("never creates the file or its parent directory", () => {
    const { agentDir } = makeRoot();
    const missing = join(agentDir, "nested", "deeper");
    loadConfig({ agentDir: missing, projectDir: missing });
    // A loader that mkdir -p'd its way to a read would leave these behind.
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(agentDir, "nested"))).toBe(false);
  });

  it("reads a valid global config", () => {
    const { agentDir } = makeRoot();
    writeGlobal(
      agentDir,
      JSON.stringify({ collapseKey: "alt+o", guidance: { promptSnippet: "x" } }),
    );
    const { config, warnings } = loadConfig({ agentDir });
    expect(config.collapseKey).toBe("alt+o");
    expect(config.guidance?.promptSnippet).toBe("x");
    expect(warnings).toEqual([]);
  });

  it("lets the project layer override the global one", () => {
    const { agentDir, projectDir } = makeRoot();
    writeGlobal(agentDir, JSON.stringify({ collapseKey: "alt+o" }));
    writeProject(projectDir, JSON.stringify({ collapseKey: "ctrl+}" }));
    expect(loadConfig({ agentDir, projectDir }).config.collapseKey).toBe("ctrl+}");
  });

  it("ignores the project layer entirely when no projectDir is given", () => {
    // The caller passes ctx.cwd only for a trusted project. An untrusted
    // checkout must not be able to rebind a global key or rewrite the tool
    // description the model is handed.
    const { agentDir, projectDir } = makeRoot();
    writeGlobal(agentDir, JSON.stringify({ collapseKey: "alt+o" }));
    writeProject(projectDir, JSON.stringify({ collapseKey: "ctrl+}" }));
    expect(loadConfig({ agentDir }).config.collapseKey).toBe("alt+o");
  });

  it("merges guidance field by field instead of replacing the object", () => {
    const { agentDir, projectDir } = makeRoot();
    writeGlobal(
      agentDir,
      JSON.stringify({ guidance: { description: "g", promptSnippet: "keep me" } }),
    );
    writeProject(projectDir, JSON.stringify({ guidance: { description: "p" } }));
    const { config } = loadConfig({ agentDir, projectDir });
    expect(config.guidance).toEqual({ description: "p", promptSnippet: "keep me" });
  });

  it("keeps the global value when the project layer omits that key", () => {
    const { agentDir, projectDir } = makeRoot();
    writeGlobal(agentDir, JSON.stringify({ collapseKey: "alt+o" }));
    writeProject(projectDir, JSON.stringify({ guidance: { description: "p" } }));
    const { config } = loadConfig({ agentDir, projectDir });
    expect(config.collapseKey).toBe("alt+o");
    expect(config.guidance?.description).toBe("p");
  });

  it("falls back to defaults with a warning on malformed JSON, and never throws", () => {
    const { agentDir } = makeRoot();
    writeGlobal(agentDir, "{ not json");
    const { config, warnings } = loadConfig({ agentDir });
    expect(config).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(CONFIG_FILE_NAME);
  });

  it("warns on valid JSON that is not an object", () => {
    const { agentDir } = makeRoot();
    for (const body of ["null", "42", '"hello"', "[1,2]"]) {
      writeGlobal(agentDir, body);
      const { config, warnings } = loadConfig({ agentDir });
      expect(config).toEqual({});
      expect(warnings).toHaveLength(1);
    }
  });

  it("still applies the good layer when the other one is broken", () => {
    const { agentDir, projectDir } = makeRoot();
    writeGlobal(agentDir, JSON.stringify({ collapseKey: "alt+o" }));
    writeProject(projectDir, "]]]");
    const { config, warnings } = loadConfig({ agentDir, projectDir });
    expect(config.collapseKey).toBe("alt+o");
    expect(warnings).toHaveLength(1);
  });

  it("drops an individual unusable value silently, without a warning", () => {
    const { agentDir } = makeRoot();
    writeGlobal(agentDir, JSON.stringify({ collapseKey: 7, guidance: { description: "" } }));
    const { config, warnings } = loadConfig({ agentDir });
    expect(config.collapseKey).toBeUndefined();
    expect(config.guidance).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("validateGuidanceFields", () => {
  it("keeps only non-empty strings and a non-empty all-string array", () => {
    expect(
      validateGuidanceFields({
        description: "d",
        promptSnippet: "s",
        promptGuidelines: ["a", "b"],
      }),
    ).toEqual({ description: "d", promptSnippet: "s", promptGuidelines: ["a", "b"] });
  });

  it("drops empty, wrong-typed and partially-bad values", () => {
    expect(
      validateGuidanceFields({
        description: "",
        promptSnippet: 3,
        promptGuidelines: ["ok", ""],
      }),
    ).toEqual({});
    expect(validateGuidanceFields({ promptGuidelines: [] })).toEqual({});
    expect(validateGuidanceFields({ promptGuidelines: "not an array" })).toEqual({});
  });

  it("treats a non-object as no guidance at all", () => {
    expect(validateGuidanceFields(undefined)).toEqual({});
    expect(validateGuidanceFields(null)).toEqual({});
    expect(validateGuidanceFields("x")).toEqual({});
  });
});

describe("formatKeySpecForDisplay", () => {
  it("capitalizes each +-part of a resolved spec", () => {
    expect(formatKeySpecForDisplay("ctrl+]")).toBe("Ctrl+]");
    expect(formatKeySpecForDisplay("alt+o")).toBe("Alt+O");
    expect(formatKeySpecForDisplay("ctrl+shift+h")).toBe("Ctrl+Shift+H");
  });

  it("handles named special keys and bare keys", () => {
    expect(formatKeySpecForDisplay("f9")).toBe("F9");
    expect(formatKeySpecForDisplay("alt+escape")).toBe("Alt+Escape");
    expect(formatKeySpecForDisplay("]")).toBe("]");
  });

  it("cases compound-word named keys conventionally", () => {
    expect(formatKeySpecForDisplay("ctrl+pagedown")).toBe("Ctrl+PageDown");
    expect(formatKeySpecForDisplay("pageup")).toBe("PageUp");
  });

  it("renders the default key the way the footer hint reads", () => {
    expect(formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY)).toBe("Ctrl+]");
  });
});

describe("resolveCollapseKey", () => {
  it("returns the default when there is no configured key", () => {
    expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
  });

  it("trims and lowercases before matching", () => {
    expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
    expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
  });

  it("passes the off sentinel through, however it was cased", () => {
    expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
    expect(resolveCollapseKey({ collapseKey: "  OFF  " })).toBe(COLLAPSE_KEY_OFF);
  });

  it("accepts well-formed specs", () => {
    expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
    expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
    expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
    expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
    expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
    expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
  });

  it("rejects malformed separator placement", () => {
    expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "ctrl+]+" })).toBe(DEFAULT_COLLAPSE_KEY);
  });

  it("rejects typo'd modifiers, so a mistake cannot capture a bare key globally", () => {
    // `ctr+]` is the one that matters: pi-tui's parseKeyId keeps only the last
    // +-part as the key and asks whether the rest *include* a known modifier
    // name, discarding the others. An unvalidated `ctr+]` therefore parses as a
    // bare `]`, and the raw terminal listener would eat every `]` typed anywhere.
    expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
  });

  it("rejects unknown base keys", () => {
    expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
  });
});

describe("the accepted grammar against pi-tui's real matcher", () => {
  // The expected answer comes from `matchesKey` at run time, not from a
  // transcription of it, so this fails if pi-tui's key table moves or if the
  // copy in config.ts drifts from it. A bare printable key matches its own
  // literal input, which makes the range enumerable without inventing escape
  // sequences.
  //
  // Enumerated by codepoint and never typed as a literal: a hand-written list
  // of symbols has to escape `\\` and `"`, and a copy that loses one agrees
  // with a source that lost the same one. Space is excluded because the named
  // key "space" covers it, `+` because it is the separator, and uppercase
  // letters because specs are lowercased before they are validated.
  const PRINTABLE = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
    String.fromCharCode(0x20 + i),
  ).filter((c) => c !== " " && c !== "+" && c === c.toLowerCase());

  it("accepts every bare printable key pi-tui can actually match", () => {
    const live = PRINTABLE.filter((c) => matchesKey(c, c as Parameters<typeof matchesKey>[1]));
    const rejected = live.filter((c) => resolveCollapseKey({ collapseKey: c }) !== c);
    expect(rejected).toEqual([]);
    expect(live.length).toBeGreaterThan(50);
  });

  it("rejects every printable key pi-tui would never match", () => {
    // Upstream accepted `"` here. It parses, binds, and then matches nothing:
    // a shortcut that silently does not exist, with no fallback to the default.
    const dead = PRINTABLE.filter((c) => !matchesKey(c, c as Parameters<typeof matchesKey>[1]));
    expect(dead).toContain('"');
    for (const c of dead) {
      expect(resolveCollapseKey({ collapseKey: c })).toBe(DEFAULT_COLLAPSE_KEY);
    }
  });

  it("keeps every named special key it advertises in step with the matcher", () => {
    const named = [
      "escape",
      "esc",
      "enter",
      "return",
      "tab",
      "space",
      "backspace",
      "delete",
      "insert",
      "clear",
      "home",
      "end",
      "pageup",
      "pagedown",
      "up",
      "down",
      "left",
      "right",
      ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
    ];
    for (const key of named) {
      expect(resolveCollapseKey({ collapseKey: key })).toBe(key);
    }
    // pageUp reaches pi-tui's switch lowercased, which is why we store it that way.
    expect(named).not.toContain("pageUp");
  });
});
