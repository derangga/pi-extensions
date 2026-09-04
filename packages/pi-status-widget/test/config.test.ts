import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  isPreset,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "../src/config.js";
import { PRESET_DEFINITIONS, PRESET_VALUES } from "../src/presets.js";
import { registry } from "../src/widgets/registry.js";
import { WidgetStore } from "../src/widgets/store.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-statusbar-"));
  configPath = join(dir, "pi-statusbar.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("presets", () => {
  it("ships exactly the three layouts", () => {
    expect(PRESET_VALUES).toEqual(["default", "compact", "git-heavy"]);
  });

  it("names only widget types this build registers", () => {
    // A preset naming a type the registry does not know would silently render a
    // shorter line, since config normalization drops unknown types.
    const unregistered = Object.values(PRESET_DEFINITIONS)
      .flatMap((definition) => definition.lines.flat())
      .map((widget) => widget.type)
      .filter((type) => registry.maybeSpec(type) === undefined);
    expect(unregistered).toEqual([]);
  });

  it("carries no icon mode, so a preset switch cannot overwrite the user's font choice", () => {
    for (const definition of Object.values(PRESET_DEFINITIONS)) {
      expect(definition).not.toHaveProperty("iconMode");
    }
  });
});

describe("defaults", () => {
  it("starts enabled on the default preset with emoji icons", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.preset).toBe("default");
    expect(DEFAULT_CONFIG.iconMode).toBe("emoji");
    expect(DEFAULT_CONFIG.separator).toBe("dot");
  });

  it("materializes the preset's widgets", () => {
    expect(DEFAULT_CONFIG.lines[0]?.map((widget) => widget.type)).toEqual([
      "model-provider",
      "thinking-level",
      "context-length",
      "git-branch",
      "git-diff",
      "cost",
      "total-time",
    ]);
  });

  it("clones deeply, so a caller cannot mutate the shared default", () => {
    const clone = cloneConfig(DEFAULT_CONFIG);
    const widget = clone.lines[0]?.[0];
    if (widget) widget.options.icon = "changed";
    expect(DEFAULT_CONFIG.lines[0]?.[0]?.options.icon).not.toBe("changed");
  });
});

describe("switching preset", () => {
  it("replaces the layout and the separator", () => {
    const next = configWithPreset(cloneConfig(DEFAULT_CONFIG), "git-heavy");
    expect(next.preset).toBe("git-heavy");
    expect(next.separator).toBe("dot");
    expect(next.lines[0]?.map((widget) => widget.type)).toContain("git-ahead-behind");
  });

  it("keeps an explicit icon choice through the switch", () => {
    // The decision this package makes differently from pi-footer.
    const chosen = { ...cloneConfig(DEFAULT_CONFIG), iconMode: "nerd" as const };
    expect(configWithPreset(chosen, "compact").iconMode).toBe("nerd");
    expect(configWithPreset(chosen, "git-heavy").iconMode).toBe("nerd");
  });

  it("keeps the enabled flag through the switch", () => {
    const disabled = { ...cloneConfig(DEFAULT_CONFIG), enabled: false };
    expect(configWithPreset(disabled, "compact").enabled).toBe(false);
  });
});

describe("normalization", () => {
  it("falls back to defaults for a value that is not an object", () => {
    expect(normalizeConfig(null).preset).toBe("default");
    expect(normalizeConfig("nonsense").preset).toBe("default");
    expect(normalizeConfig(42).lines).toHaveLength(1);
  });

  it("keeps recognized values and replaces the rest", () => {
    const config = normalizeConfig({
      version: 99,
      enabled: false,
      preset: "compact",
      separator: "pipe",
      separatorFg: "brightBlack",
      separatorBg: "nonsense",
      iconMode: "nerd",
    });
    expect(config.version).toBe(1);
    expect(config.enabled).toBe(false);
    expect(config.preset).toBe("compact");
    expect(config.separator).toBe("pipe");
    expect(config.separatorFg).toBe("brightBlack");
    expect(config.separatorBg).toBe("default");
    expect(config.iconMode).toBe("nerd");
  });

  it("takes the separator from the preset when the file does not name one", () => {
    expect(normalizeConfig({ preset: "compact" }).separator).toBe("space");
  });

  it("rejects an icon mode this build dropped", () => {
    // pi-footer's third mode. A stale config must not select something the icon
    // sets no longer carry.
    expect(normalizeConfig({ iconMode: "text" }).iconMode).toBe("emoji");
  });

  it("keeps a hand-written line, dropping only the entries it cannot render", () => {
    const config = normalizeConfig({
      lines: [[{ type: "model" }, { type: "invented-widget" }, { type: "cost" }], "not-a-line"],
    });
    expect(config.lines[0]?.map((widget) => widget.type)).toEqual(["model", "cost"]);
    expect(config.lines[1]).toEqual([]);
  });

  it("fills in an id and the enabled flag a hand-written entry omits", () => {
    const widget = normalizeConfig({ lines: [[{ type: "model" }]] }).lines[0]?.[0];
    expect(widget?.id.length).toBeGreaterThan(0);
    expect(widget?.enabled).toBe(true);
  });

  it("sanitizes hand-written options through the widget's own spec", () => {
    const widget = normalizeConfig({
      lines: [[{ type: "git-diff", options: { gitDiffMode: "sideways", nonsense: true } }]],
    }).lines[0]?.[0];
    expect(widget?.options.gitDiffMode).toBe("plain");
    expect(widget?.options.nonsense).toBeUndefined();
  });

  it("preserves a preset's own widget options", () => {
    const diff = DEFAULT_CONFIG.lines[0]?.find((widget) => widget.type === "git-diff");
    expect(diff?.options.gitDiffMode).toBe("compact");
  });
});

describe("loading", () => {
  it("returns defaults with no error when the file does not exist", async () => {
    // The normal first run.
    const loaded = await loadConfig(configPath);
    expect(loaded.error).toBeUndefined();
    expect(loaded.config.preset).toBe("default");
  });

  it("falls back to defaults and reports why on malformed JSON", async () => {
    // pi-footer rethrows here, which stops the extension loading.
    await writeFile(configPath, "{ not json", "utf8");
    const loaded = await loadConfig(configPath);
    expect(loaded.config.preset).toBe("default");
    expect(loaded.error).toContain("not valid JSON");
  });

  it("falls back to defaults and reports why when the path is unreadable", async () => {
    const loaded = await loadConfig(dir);
    expect(loaded.config.preset).toBe("default");
    expect(loaded.error).toContain("could not read");
  });

  it("round-trips a saved config", async () => {
    const saved = configWithPreset(cloneConfig(DEFAULT_CONFIG), "compact");
    saved.iconMode = "nerd";
    await saveConfig(saved, configPath);
    const loaded = await loadConfig(configPath);
    expect(loaded.error).toBeUndefined();
    expect(loaded.config.preset).toBe("compact");
    expect(loaded.config.iconMode).toBe("nerd");
    expect(loaded.config.lines[0]?.map((widget) => widget.type)).toEqual(
      saved.lines[0]?.map((widget) => widget.type),
    );
  });

  it("creates the directory it writes into", async () => {
    const nested = join(dir, "deep", "extensions", "pi-statusbar.json");
    await saveConfig(cloneConfig(DEFAULT_CONFIG), nested);
    expect((await loadConfig(nested)).config.preset).toBe("default");
  });
});

describe("isPreset", () => {
  it("accepts the three names and nothing else", () => {
    expect(isPreset("git-heavy")).toBe(true);
    expect(isPreset("powerline")).toBe(false);
    expect(isPreset(undefined)).toBe(false);
  });
});

describe("widget store", () => {
  it("hydrates every config entry into a renderable widget", () => {
    const store = WidgetStore.fromConfig(DEFAULT_CONFIG);
    expect(store.lines[0]).toHaveLength(7);
    expect(store.settings.preset).toBe("default");
    expect(store.lines[0]?.[0]?.type).toBe("model-provider");
  });

  it("round-trips back to a config", () => {
    const store = WidgetStore.fromConfig(DEFAULT_CONFIG);
    const config = store.toConfig();
    expect(config.lines[0]?.map((widget) => widget.type)).toEqual(
      DEFAULT_CONFIG.lines[0]?.map((widget) => widget.type),
    );
    expect(config.iconMode).toBe(DEFAULT_CONFIG.iconMode);
  });

  it("holds settings the caller cannot mutate through the original config", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    const store = WidgetStore.fromConfig(config);
    config.iconMode = "nerd";
    expect(store.settings.iconMode).toBe("emoji");
  });
});
