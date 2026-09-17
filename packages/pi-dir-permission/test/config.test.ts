import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  EMOJI_ICON,
  icon,
  loadConfig,
  NERD_ICON,
  statusText,
} from "../src/config.js";
import { describe, expect, it } from "vitest";
import type { Grant } from "../src/boundary.js";

function layer(contents: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "dir-permission-config-"));
  if (contents !== undefined) {
    writeFileSync(join(dir, CONFIG_FILE_NAME), contents);
  }
  return dir;
}

function grants(count: number): Grant[] {
  return Array.from({ length: count }, (_, index) => ({
    absolutePath: `/repo-${index}`,
    label: `repo-${index}`,
  }));
}

describe("loadConfig", () => {
  it("defaults when neither layer has a file, without warning about it", () => {
    const result = loadConfig(layer(undefined), layer(undefined));
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toEqual([]);
  });

  it("reads the icon mode, the override and the extra tools", () => {
    const dir = layer(
      JSON.stringify({ iconMode: "nerd", icon: "D", gatedTools: { some_tool: "file_path" } }),
    );
    const { config } = loadConfig(dir, undefined);
    expect(config.iconMode).toBe("nerd");
    expect(config.icon).toBe("D");
    expect(config.gatedTools.get("some_tool")).toBe("file_path");
  });

  it("lets the workspace layer override the global one", () => {
    const global = layer(JSON.stringify({ iconMode: "nerd" }));
    const project = layer(JSON.stringify({ iconMode: "emoji" }));
    expect(loadConfig(global, project).config.iconMode).toBe("emoji");
  });

  it("keeps the global layer for keys the workspace layer leaves out", () => {
    const global = layer(JSON.stringify({ iconMode: "nerd", icon: "G" }));
    const project = layer(JSON.stringify({ gatedTools: { t: "path" } }));
    const { config } = loadConfig(global, project);
    expect(config.icon).toBe("G");
    expect(config.gatedTools.get("t")).toBe("path");
  });

  it("degrades to defaults and says why when a file is malformed", () => {
    const result = loadConfig(layer("{ not json"), undefined);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toHaveLength(1);
  });

  it("ignores values of the wrong shape, one key at a time", () => {
    const result = loadConfig(
      layer(JSON.stringify({ iconMode: "neon", icon: 7, gatedTools: { good: "path", bad: 3 } })),
      undefined,
    );
    expect(result.config.iconMode).toBe("emoji");
    expect(result.config.icon).toBeUndefined();
    expect(result.config.gatedTools.get("good")).toBe("path");
    expect(result.config.gatedTools.has("bad")).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it("does not read a file it was not pointed at", () => {
    const dir = mkdtempSync(join(tmpdir(), "dir-permission-config-"));
    mkdirSync(join(dir, CONFIG_FILE_NAME));
    expect(loadConfig(dir, undefined).config).toEqual(DEFAULT_CONFIG);
  });
});

describe("icon", () => {
  it("follows the mode, and yields to an explicit override", () => {
    expect(icon(DEFAULT_CONFIG)).toBe(EMOJI_ICON);
    expect(icon({ ...DEFAULT_CONFIG, iconMode: "nerd" })).toBe(NERD_ICON);
    expect(icon({ ...DEFAULT_CONFIG, iconMode: "nerd", icon: "*" })).toBe("*");
  });
});

describe("statusText", () => {
  it("says nothing while the boundary is just the workspace", () => {
    expect(statusText([], DEFAULT_CONFIG)).toBeUndefined();
  });

  it("counts the grants, singular and plural", () => {
    expect(statusText(grants(1), DEFAULT_CONFIG)).toBe(`${EMOJI_ICON} 1 external dir`);
    expect(statusText(grants(2), DEFAULT_CONFIG)).toBe(`${EMOJI_ICON} 2 external dirs`);
  });
});
