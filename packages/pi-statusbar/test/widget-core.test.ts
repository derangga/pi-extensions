import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { contextForDependencies } from "../src/widgets/context.js";
import { registry } from "../src/widgets/registry.js";
import { defaultOptionsFromSpec, sanitizeOptionsFromSpec } from "../src/widgets/options.js";
import { instanceFor, OverrideWidget, ProbeWidget } from "./helpers/widgets.js";
import { baseCtx, statusbarData } from "./helpers/data.js";
import { partialTheme } from "./helpers/theme.js";

const widgetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "widgets");

describe("registry", () => {
  it("registers every widget module on disk", async () => {
    // A widget file that exists but never reaches the WIDGETS array renders
    // nowhere, and nothing else would notice.
    const categories = readdirSync(widgetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const defined: string[] = [];
    for (const category of categories) {
      const dir = join(widgetsDir, category);
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
        const module = (await import(join(dir, file))) as Record<string, unknown>;
        for (const exported of Object.values(module)) {
          if (
            typeof exported === "object" &&
            exported !== null &&
            typeof (exported as { type?: unknown }).type === "string" &&
            typeof (exported as { render?: unknown }).render === "function"
          ) {
            defined.push((exported as { type: string }).type);
          }
        }
      }
    }

    expect(defined).not.toHaveLength(0);
    expect(defined.sort()).toEqual(registry.specs.map((spec) => spec.type).sort());
  });

  it("keeps widget types unique", () => {
    const types = registry.specs.map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("gives every spec a description, since it is the only in-source documentation", () => {
    for (const spec of registry.specs) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("throws on an unsupported type and reports undefined for an unknown one", () => {
    // config normalization asks with maybeSpec and skips misses; the render path
    // asks with spec and a miss there is a bug rather than bad input.
    expect(() => registry.spec("nope" as never)).toThrow(/Unsupported widget type/);
    expect(registry.maybeSpec("nope")).toBeUndefined();
    expect(registry.maybeSpec("flex-separator")?.type).toBe("flex-separator");
  });

  it("creates entries with distinct ids and sanitized options", () => {
    const first = registry.createEntry("flex-separator");
    const second = registry.createEntry("flex-separator");
    expect(first.id).not.toBe(second.id);
    expect(first.enabled).toBe(true);
    expect(first.options.hideWhenEmpty).toBe(true);
  });

  it("hydrates an entry into a widget that keeps its id and options", () => {
    const widget = registry.hydrateWidget({
      id: "kept",
      type: "flex-separator",
      enabled: false,
      options: { hideWhenEmpty: true },
    });
    expect(widget.id).toBe("kept");
    expect(widget.enabled).toBe(false);
    expect(widget.render(baseCtx)).toBeUndefined();
  });
});

describe("option defaults", () => {
  it("fills base options, properties and the default style", () => {
    expect(defaultOptionsFromSpec(ProbeWidget)).toEqual({
      raw: false,
      hideWhenEmpty: false,
      hideWhenZero: false,
      icon: "",
      text: "-",
      flag: true,
      count: 5,
      mode: "compact",
      note: "none",
      warningFg: "yellow",
      fg: "cyan",
      bg: "default",
      bold: false,
    });
  });

  it("lets a spec override a base option default", () => {
    // Several widgets want an empty fallback rather than the "-" placeholder.
    const spec = { ...ProbeWidget, baseOptionDefaults: { text: "" } };
    expect(defaultOptionsFromSpec(spec).text).toBe("");
  });
});

describe("option sanitizer", () => {
  it("drops keys the spec does not declare", () => {
    // The escape hatch for configuration is a hand-edited JSON file, so a typo
    // must not reach the renderer as an option nothing validates.
    const options = sanitizeOptionsFromSpec(ProbeWidget, { nonsense: 1, mode: "full" });
    expect(options.nonsense).toBeUndefined();
    expect(options.mode).toBe("full");
  });

  it("falls back to the default on a wrong type", () => {
    const options = sanitizeOptionsFromSpec(ProbeWidget, {
      flag: "yes",
      count: "seven",
      note: 12,
      raw: "true",
      icon: 5,
    });
    expect(options.flag).toBe(true);
    expect(options.count).toBe(5);
    expect(options.note).toBe("none");
    expect(options.raw).toBe(false);
    expect(options.icon).toBe("");
  });

  it("rejects a choice outside the declared set", () => {
    expect(sanitizeOptionsFromSpec(ProbeWidget, { mode: "sideways" }).mode).toBe("compact");
  });

  it("clamps a number to its bounds and rejects a fractional one", () => {
    expect(sanitizeOptionsFromSpec(ProbeWidget, { count: 99 }).count).toBe(10);
    expect(sanitizeOptionsFromSpec(ProbeWidget, { count: -4 }).count).toBe(0);
    expect(sanitizeOptionsFromSpec(ProbeWidget, { count: 2.5 }).count).toBe(5);
  });

  it("normalizes colors, including text properties that hold one", () => {
    const options = sanitizeOptionsFromSpec(ProbeWidget, {
      fg: "magenta",
      bg: "ansi256:12",
      warningFg: "brightRed",
    });
    expect(options.fg).toBe("magenta");
    // ansi256 went with the powerline presets, so it is no longer a color and the
    // spec's own default takes over.
    expect(options.bg).toBe("default");
    expect(options.warningFg).toBe("brightRed");
  });

  it("falls back to the spec's default style when fg does not normalize", () => {
    expect(sanitizeOptionsFromSpec(ProbeWidget, { fg: "chartreuse" }).fg).toBe("cyan");
  });

  it("keeps a color key absent when the spec declares no default for it", () => {
    const spec = { ...ProbeWidget, defaultStyle: {} };
    expect(sanitizeOptionsFromSpec(spec, { fg: "nonsense" }).fg).toBeUndefined();
  });

  it("falls back when a color property holds something that is not a color", () => {
    expect(sanitizeOptionsFromSpec(ProbeWidget, { warningFg: "chartreuse" }).warningFg).toBe(
      "yellow",
    );
  });
});

describe("dependency slicing", () => {
  it("passes only the keys the spec declares", () => {
    const ctx = contextForDependencies(baseCtx, ProbeWidget.dependencies, statusbarData());
    expect(ctx.model).toBe("opus");
    expect(ctx.cwd).toBe("/home/dev/repo");
    expect("git" in ctx).toBe(false);
    expect("metrics" in ctx).toBe(false);
  });

  it("carries the render context through untouched", () => {
    const theme = partialTheme(["dim"]);
    const ctx = contextForDependencies({ ...baseCtx, theme }, [], statusbarData());
    expect(ctx.iconMode).toBe("emoji");
    expect(ctx.colorLevel).toBe("none");
    expect(ctx.theme).toBe(theme);
  });
});

describe("widget rendering", () => {
  it("prefixes the icon for the active mode", () => {
    const widget = instanceFor(ProbeWidget, { options: sanitizeOptionsFromSpec(ProbeWidget, {}) });
    expect(widget.render({ ...baseCtx, model: "opus" } as never)).toBe("[emoji] opus");
    expect(widget.render({ ...baseCtx, iconMode: "nerd", model: "opus" } as never)).toBe(
      "[nerd] opus",
    );
  });

  it("prefers an explicit icon override, with no separating space", () => {
    const widget = instanceFor(ProbeWidget, {
      options: sanitizeOptionsFromSpec(ProbeWidget, { icon: " R" }),
    });
    expect(widget.render({ ...baseCtx, model: "opus" } as never)).toBe(" Ropus");
  });

  it("drops the icon entirely when raw is set", () => {
    const widget = instanceFor(ProbeWidget, {
      options: sanitizeOptionsFromSpec(ProbeWidget, { raw: true }),
    });
    expect(widget.render({ ...baseCtx, model: "opus" } as never)).toBe("opus");
  });

  it("falls back to the text placeholder for an empty value", () => {
    const widget = instanceFor(ProbeWidget, { options: sanitizeOptionsFromSpec(ProbeWidget, {}) });
    expect(widget.render({ ...baseCtx, model: undefined } as never)).toBe("[emoji] -");
  });

  it("hides an empty value when asked, rather than showing the placeholder", () => {
    const widget = instanceFor(ProbeWidget, {
      options: sanitizeOptionsFromSpec(ProbeWidget, { hideWhenEmpty: true }),
    });
    expect(widget.render({ ...baseCtx, model: undefined } as never)).toBeUndefined();
  });

  it("hides a zero value when asked", () => {
    const widget = instanceFor(ProbeWidget, {
      options: sanitizeOptionsFromSpec(ProbeWidget, { hideWhenZero: true }),
    });
    expect(widget.render({ ...baseCtx, model: "0" } as never)).toBeUndefined();
    expect(widget.render({ ...baseCtx, model: "01" } as never)).toBe("[emoji] 01");
  });

  it("renders nothing at all when disabled", () => {
    const widget = instanceFor(ProbeWidget, {
      enabled: false,
      options: sanitizeOptionsFromSpec(ProbeWidget, {}),
    });
    expect(widget.render({ ...baseCtx, model: "opus" } as never)).toBeUndefined();
  });

  it("applies the widget's own colors", () => {
    const widget = instanceFor(ProbeWidget, {
      options: sanitizeOptionsFromSpec(ProbeWidget, { fg: "red", raw: true }),
    });
    expect(widget.render({ ...baseCtx, colorLevel: "ansi", model: "opus" } as never)).toBe(
      "\x1b[31mopus\x1b[39m",
    );
  });

  it("lets a render-time color override the configured one", () => {
    // This is how a widget colors itself conditionally: the thinking level and
    // the context thresholds both pass a color in at render time.
    const widget = instanceFor(OverrideWidget, {
      options: sanitizeOptionsFromSpec(OverrideWidget, { fg: "red", raw: true }),
    });
    expect(widget.render({ ...baseCtx, colorLevel: "ansi", model: "opus" } as never)).toBe(
      "\x1b[32mopus\x1b[39m",
    );
  });

  it("toggles, updates options and round-trips to an entry", () => {
    const widget = instanceFor(ProbeWidget, { options: sanitizeOptionsFromSpec(ProbeWidget, {}) });
    widget.toggle();
    widget.update({ note: "changed" });
    const entry = widget.toEntry();
    expect(entry.enabled).toBe(false);
    expect(entry.options.note).toBe("changed");
    expect(entry.id).toBe("probe-1");
  });
});
