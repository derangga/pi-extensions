import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  COMMAND_NAME,
  describeSettings,
  parseStatusbarCommand,
  registerStatusbarCommand,
  USAGE,
} from "../src/command.js";
import { cloneConfig, DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { PRESET_DEFINITIONS } from "../src/presets.js";
import { SCHEME_NAMES } from "../src/schemes.js";
import { SEPARATOR_VALUES } from "../src/separators.js";
import type { StatusbarConfig } from "../src/types.js";
import { stubApi, stubContext } from "./helpers/pi.js";

describe("parseStatusbarCommand", () => {
  it("shows the current settings when given nothing", () => {
    expect(parseStatusbarCommand("")).toEqual({ kind: "show" });
    expect(parseStatusbarCommand("   ")).toEqual({ kind: "show" });
  });

  it("reads the enabled flag from on and off", () => {
    expect(parseStatusbarCommand("on")).toEqual({ kind: "enabled", enabled: true });
    expect(parseStatusbarCommand("off")).toEqual({ kind: "enabled", enabled: false });
  });

  it("reads reset", () => {
    expect(parseStatusbarCommand("reset")).toEqual({ kind: "reset" });
  });

  it("reads each shipped preset", () => {
    for (const preset of ["default", "compact", "git-heavy"] as const) {
      expect(parseStatusbarCommand(`preset ${preset}`)).toEqual({ kind: "preset", preset });
    }
  });

  it("reads each separator style", () => {
    for (const separator of SEPARATOR_VALUES) {
      expect(parseStatusbarCommand(`separator ${separator}`)).toEqual({
        kind: "separator",
        separator,
      });
    }
  });

  it("reads each icon mode", () => {
    expect(parseStatusbarCommand("icons emoji")).toEqual({ kind: "icons", iconMode: "emoji" });
    expect(parseStatusbarCommand("icons nerd")).toEqual({ kind: "icons", iconMode: "nerd" });
  });

  it("ignores case and surrounding whitespace", () => {
    expect(parseStatusbarCommand("  PRESET  Git-Heavy  ")).toEqual({
      kind: "preset",
      preset: "git-heavy",
    });
    expect(parseStatusbarCommand("ON")).toEqual({ kind: "enabled", enabled: true });
  });

  it("falls back to usage rather than applying half a change", () => {
    // A preset or icon name that does not exist must not reach the config.
    expect(parseStatusbarCommand("preset")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("preset powerline")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("icons")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("icons text")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("separator")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("separator powerline-left")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("enable")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("nonsense")).toEqual({ kind: "usage" });
  });
});

describe("describeSettings and the scheme", () => {
  it("names the active scheme, so the headless summary says which one is on", () => {
    expect(describeSettings(cloneConfig(DEFAULT_CONFIG), "/path")).toContain("colors default");
    expect(
      describeSettings(
        { ...cloneConfig(DEFAULT_CONFIG), colorScheme: "catppuccin-mocha" },
        "/path",
      ),
    ).toContain("colors catppuccin-mocha");
  });
});

describe("describeSettings", () => {
  it("names the separator, which is otherwise invisible when it is a space", () => {
    // compact ships a space separator, which looks exactly like a missing one.
    const config: StatusbarConfig = { ...cloneConfig(DEFAULT_CONFIG), separator: "space" };
    expect(describeSettings(config, "/path")).toContain("separator space");
  });

  it("names the state, the layout, the icons and the file to hand-edit", () => {
    const config: StatusbarConfig = { ...cloneConfig(DEFAULT_CONFIG), iconMode: "nerd" };
    const described = describeSettings(config, "/home/dev/.pi/extensions/pi-statusbar.json");

    expect(described).toContain("on");
    expect(described).toContain("preset default");
    expect(described).toContain("icons nerd");
    expect(described).toContain("/home/dev/.pi/extensions/pi-statusbar.json");
  });

  it("lists what else is typeable, so the bare command is never a dead end", () => {
    // The first thing anyone types is `/statusbar` with no argument. If that
    // prints only the current state, every other subcommand is undiscoverable.
    const described = describeSettings(cloneConfig(DEFAULT_CONFIG), "/path");
    expect(described).toContain(USAGE);
    for (const word of ["preset", "icons", "reset", "on | off"]) {
      expect(described).toContain(`/statusbar ${word}`);
    }
  });

  it("reports a disabled footer as off", () => {
    const config: StatusbarConfig = { ...cloneConfig(DEFAULT_CONFIG), enabled: false };
    expect(describeSettings(config, "/path")).toContain("off");
  });
});

interface HostStub {
  config: StatusbarConfig;
  commits: StatusbarConfig[];
  /** Kept apart from commits, since a preview is the case that must not write. */
  previews: StatusbarConfig[];
}

/** Drives the command against a host that records commits instead of touching disk. */
function hosted(
  initial: StatusbarConfig = cloneConfig(DEFAULT_CONFIG),
  contextOptions: Parameters<typeof stubContext>[0] = {},
) {
  const state: HostStub = { config: initial, commits: [], previews: [] };
  const api = stubApi();
  const context = stubContext(contextOptions);

  registerStatusbarCommand(api.pi, {
    current: () => state.config,
    commit: async (next: StatusbarConfig, _ctx: ExtensionCommandContext) => {
      state.config = next;
      state.commits.push(next);
    },
    preview: (next: StatusbarConfig, _ctx: ExtensionCommandContext) => {
      state.config = next;
      state.previews.push(next);
    },
  });

  return {
    state,
    context,
    run: (args: string) => api.run(COMMAND_NAME, args, context.ctx),
    commands: api.commands,
  };
}

describe("registerStatusbarCommand", () => {
  it("registers under /statusbar with a description", () => {
    const { commands } = hosted();
    expect(commands.get(COMMAND_NAME)?.description).toBeTruthy();
  });

  it("prints the current settings and the config path with no terminal to draw in", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), { hasUI: false });
    await host.run("");

    expect(host.state.commits).toHaveLength(0);
    expect(host.context.notifications).toHaveLength(1);
    expect(host.context.notifications[0]?.message).toContain("preset default");
    expect(host.context.notifications[0]?.message).toContain("pi-statusbar.json");
    expect(host.context.notifications[0]?.message).toContain(USAGE);
  });

  it("warns with the usage text and changes nothing on a bad argument", async () => {
    const host = hosted();
    await host.run("preset powerline");

    expect(host.state.commits).toHaveLength(0);
    expect(host.context.notifications[0]?.message).toBe(USAGE);
    expect(host.context.notifications[0]?.type).toBe("warning");
  });

  it("switches the preset and its separator", async () => {
    const host = hosted();
    await host.run("preset compact");

    expect(host.state.commits).toHaveLength(1);
    expect(host.state.config.preset).toBe("compact");
    expect(host.state.config.separator).toBe("space");
    expect(host.context.notifications[0]?.message).toContain("compact");
  });

  it("keeps an explicit icon choice across a later preset switch, either way", async () => {
    // Presets carry no icon hint: a font capability belongs to the terminal
    // rather than to a layout, so switching layout must not undo the choice.
    // Both directions, because asserting only the non-default mode cannot tell
    // a preserved choice from a preset that forces that same mode. Upstream's
    // git-heavy forces nerd, which is the bug this pins down.
    const toNerd = hosted();
    await toNerd.run("icons nerd");
    await toNerd.run("preset git-heavy");
    expect(toNerd.state.config.iconMode).toBe("nerd");
    expect(toNerd.state.config.preset).toBe("git-heavy");

    const toEmoji = hosted({ ...cloneConfig(DEFAULT_CONFIG), iconMode: "nerd" });
    await toEmoji.run("icons emoji");
    await toEmoji.run("preset git-heavy");
    expect(toEmoji.state.config.iconMode).toBe("emoji");
    expect(toEmoji.state.config.preset).toBe("git-heavy");
  });

  it("sets the separator on its own, leaving the layout alone", async () => {
    const host = hosted();
    await host.run("separator pipe");

    expect(host.state.config.separator).toBe("pipe");
    expect(host.state.config.preset).toBe(DEFAULT_CONFIG.preset);
    expect(host.context.notifications[0]?.message).toContain("pipe");
  });

  it("lets the preset take the separator back, which is the preset's job", async () => {
    // A preset is a whole look, separator included. Anyone who wants one
    // style to outlive a preset switch has the config file.
    const host = hosted();
    await host.run("separator pipe");
    await host.run("preset compact");

    expect(host.state.config.separator).toBe(PRESET_DEFINITIONS.compact.separator);
  });

  it("names every separator style in the usage, so none is undiscoverable", () => {
    for (const separator of SEPARATOR_VALUES) expect(USAGE).toContain(separator);
  });

  it("sets every one of the twelve schemes, and default to get back out", async () => {
    // Walked, because a scheme that parses nowhere is a scheme nobody can
    // reach from the prompt, and the panel is the only other way in.
    const names = [...SCHEME_NAMES, "default"];
    const applied: string[] = [];
    for (const name of names) {
      const host = hosted();
      await host.run(`colors ${name}`);
      const said = host.context.notifications[0]?.message ?? "";
      applied.push(
        `${name}: commits=${host.state.commits.length} set=${host.state.config.colorScheme} said=${said.includes(name)}`,
      );
    }
    expect(applied).toEqual(names.map((name) => `${name}: commits=1 set=${name} said=true`));
  });

  it("warns with the usage and changes nothing on a scheme it does not know", async () => {
    const bad = ["gruvbox", "", "catppuccin", "tokyo", "mocha", "#f38ba8"];
    const outcomes: string[] = [];
    for (const value of bad) {
      const host = hosted();
      await host.run(`colors ${value}`.trim());
      const notification = host.context.notifications[0];
      outcomes.push(
        `${value || "(none)"}: commits=${host.state.commits.length} ${notification?.type} usage=${notification?.message === USAGE}`,
      );
    }
    expect(outcomes).toEqual(
      bad.map((value) => `${value || "(none)"}: commits=0 warning usage=true`),
    );
  });

  it("takes a scheme name in any case, like every other typed argument", async () => {
    // The command lowercases its arguments, so `preset DEFAULT` already works.
    // The config file stays case-sensitive: that is data, not something typed.
    const host = hosted();
    await host.run("colors Catppuccin-Mocha");

    expect(host.state.config.colorScheme).toBe("catppuccin-mocha");
    expect(normalizeConfig({ colorScheme: "Catppuccin-Mocha" }).colorScheme).toBe("default");
  });

  it("sets a scheme without disturbing the layout or the icons", async () => {
    const host = hosted();
    await host.run("colors tokyo-night");

    expect(host.state.config.colorScheme).toBe("tokyo-night");
    expect(host.state.config.preset).toBe(DEFAULT_CONFIG.preset);
    expect(host.state.config.iconMode).toBe(DEFAULT_CONFIG.iconMode);
  });

  it("names the subcommand in the usage without listing all twelve schemes", () => {
    expect(USAGE).toContain("/statusbar colors <scheme>");
    // Naming one would mean naming twelve, which is what the panel is for.
    const named = SCHEME_NAMES.filter((name) => USAGE.includes(name));
    expect(named).toEqual([]);
  });

  it("keeps every usage line inside 80 columns", () => {
    // Notifications are not wrapped for us, so a long line breaks the column
    // the descriptions line up in.
    const tooWide = USAGE.split("\n")
      .filter((line) => visibleWidth(line) > 80)
      .map((line) => `${visibleWidth(line)}: ${line}`);
    expect(tooWide).toEqual([]);
  });

  it("keeps the settings summary inside 80 columns for the longest scheme name", () => {
    const widest = [...SCHEME_NAMES].sort((a, b) => b.length - a.length)[0]!;
    const described = describeSettings(
      { ...cloneConfig(DEFAULT_CONFIG), colorScheme: widest, preset: "git-heavy" },
      "/path",
    );
    const tooWide = described.split("\n").filter((line) => visibleWidth(line) > 80);
    expect(tooWide).toEqual([]);
  });

  it("switches icons without disturbing the layout", async () => {
    const host = hosted();
    await host.run("preset git-heavy");
    await host.run("icons nerd");

    expect(host.state.config.preset).toBe("git-heavy");
    expect(host.state.config.iconMode).toBe("nerd");
  });

  it("turns the footer off and back on", async () => {
    const host = hosted();

    await host.run("off");
    expect(host.state.config.enabled).toBe(false);

    await host.run("on");
    expect(host.state.config.enabled).toBe(true);
    expect(host.state.commits).toHaveLength(2);
  });

  it("restores every default on reset, icon choice included", async () => {
    const host = hosted();
    await host.run("icons nerd");
    await host.run("preset compact");
    await host.run("off");
    await host.run("reset");

    expect(host.state.config.preset).toBe(DEFAULT_CONFIG.preset);
    expect(host.state.config.iconMode).toBe(DEFAULT_CONFIG.iconMode);
    expect(host.state.config.enabled).toBe(true);
  });

  it("commits once per mutation and never for a read", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), { hasUI: false });
    await host.run("");
    await host.run("nonsense");
    await host.run("on");

    expect(host.state.commits).toHaveLength(1);
  });
});
