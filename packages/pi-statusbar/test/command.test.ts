import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildMenu,
  COMMAND_NAME,
  describeSettings,
  parseStatusbarCommand,
  MENU_TITLE,
  registerStatusbarCommand,
  USAGE,
} from "../src/command.js";
import { cloneConfig, DEFAULT_CONFIG } from "../src/config.js";
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
    expect(parseStatusbarCommand("enable")).toEqual({ kind: "usage" });
    expect(parseStatusbarCommand("nonsense")).toEqual({ kind: "usage" });
  });
});

describe("describeSettings", () => {
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
}

/** Drives the command against a host that records commits instead of touching disk. */
function hosted(
  initial: StatusbarConfig = cloneConfig(DEFAULT_CONFIG),
  contextOptions: Parameters<typeof stubContext>[0] = {},
) {
  const state: HostStub = { config: initial, commits: [] };
  const api = stubApi();
  const context = stubContext(contextOptions);

  registerStatusbarCommand(api.pi, {
    current: () => state.config,
    commit: async (next: StatusbarConfig, _ctx: ExtensionCommandContext) => {
      state.config = next;
      state.commits.push(next);
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

describe("buildMenu", () => {
  it("shows the current value on the row that changes it", () => {
    const config: StatusbarConfig = {
      ...cloneConfig(DEFAULT_CONFIG),
      preset: "git-heavy",
      iconMode: "nerd",
    };
    const labels = buildMenu(config).map((entry) => entry.label);

    expect(labels[0]).toContain("git-heavy");
    expect(labels[1]).toContain("nerd");
  });

  it("names the direction the toggle would move, not the state it is in", () => {
    // A row reading "on" is ambiguous: it could be the current state or the
    // thing about to happen. Naming the action leaves nothing to guess.
    expect(buildMenu(cloneConfig(DEFAULT_CONFIG))[2]?.label).toBe("Turn the footer off");
    expect(buildMenu({ ...cloneConfig(DEFAULT_CONFIG), enabled: false })[2]?.label).toBe(
      "Turn the footer on",
    );
  });

  it("offers every preset and every icon mode, and nothing that cannot be parsed", () => {
    const menu = buildMenu(cloneConfig(DEFAULT_CONFIG));
    expect(menu[0]?.options.map((option) => option.label)).toEqual([
      "default",
      "compact",
      "git-heavy",
    ]);
    expect(menu[1]?.options.map((option) => option.label)).toEqual(["emoji", "nerd"]);
  });

  it("gives every row at least one option, so no row is a dead end", () => {
    for (const entry of buildMenu(cloneConfig(DEFAULT_CONFIG))) {
      expect(entry.options.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the /statusbar picker", () => {
  it("opens on the bare command and drills into a second picker", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), {
      selections: ["Layout preset · default", "compact"],
    });
    await host.run("");

    expect(host.context.selects[0]?.title).toBe(MENU_TITLE);
    expect(host.context.selects[1]?.title).toBe("Layout preset · default");
    expect(host.context.selects[1]?.options).toEqual(["default", "compact", "git-heavy"]);
    expect(host.state.config.preset).toBe("compact");
  });

  it("applies a single-option row without a second picker", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), { selections: ["Turn the footer off"] });
    await host.run("");

    expect(host.context.selects).toHaveLength(1);
    expect(host.state.config.enabled).toBe(false);
  });

  it("commits nothing when the first picker is cancelled", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), { selections: [undefined] });
    await host.run("");

    expect(host.context.selects).toHaveLength(1);
    expect(host.state.commits).toHaveLength(0);
    expect(host.context.notifications).toHaveLength(0);
  });

  it("commits nothing when the second picker is cancelled", async () => {
    // The escape has to hold at both depths. Backing out of the preset list
    // must not leave the first choice half-applied.
    const host = hosted(cloneConfig(DEFAULT_CONFIG), {
      selections: ["Layout preset · default", undefined],
    });
    await host.run("");

    expect(host.context.selects).toHaveLength(2);
    expect(host.state.commits).toHaveLength(0);
  });

  it("stays out of the way when arguments are typed", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), { selections: ["Reset to defaults"] });
    await host.run("preset compact");

    expect(host.context.selects).toHaveLength(0);
    expect(host.state.config.preset).toBe("compact");
  });

  it("reaches the settings text through the picker too", async () => {
    const host = hosted(cloneConfig(DEFAULT_CONFIG), {
      selections: ["Show settings and config path"],
    });
    await host.run("");

    expect(host.context.selects).toHaveLength(1);
    expect(host.state.commits).toHaveLength(0);
    expect(host.context.notifications[0]?.message).toContain("pi-statusbar.json");
  });
});
