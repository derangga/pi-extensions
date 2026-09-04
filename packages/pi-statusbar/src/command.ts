import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  getConfigPath,
  isIconMode,
  isPreset,
} from "./config.js";
import { PRESET_VALUES, type Preset } from "./presets.js";
import { ICON_MODE_VALUES, type IconMode, type StatusbarConfig } from "./types.js";

export const COMMAND_NAME = "statusbar";

/**
 * The whole config surface, in place of pi-footer's 26-file terminal editor.
 * Three presets is a small enough space that a picker beats a builder, and the
 * file path is on the first line because hand-editing is the way to reach
 * anything this command does not cover.
 */
export const USAGE = [
  "Usage:",
  "  /statusbar                                    open the settings picker",
  "  /statusbar preset <default|compact|git-heavy> switch layout",
  "  /statusbar icons <emoji|nerd>                 switch icon set",
  "  /statusbar on | off                           show or hide the footer",
  "  /statusbar reset                              restore defaults",
].join("\n");

export type StatusbarCommand =
  | { kind: "show" }
  | { kind: "preset"; preset: Preset }
  | { kind: "icons"; iconMode: IconMode }
  | { kind: "enabled"; enabled: boolean }
  | { kind: "reset" }
  | { kind: "usage" };

/**
 * Turns a typed argument string into an intent. Every value is checked against
 * the domain it belongs to, and anything left over becomes `usage` rather than
 * a half-applied change.
 */
export function parseStatusbarCommand(args: string): StatusbarCommand {
  const [name, value] = args.trim().toLowerCase().split(/\s+/, 2);
  if (!name) return { kind: "show" };

  if (name === "on") return { kind: "enabled", enabled: true };
  if (name === "off") return { kind: "enabled", enabled: false };
  if (name === "reset") return { kind: "reset" };
  if (name === "preset" && isPreset(value)) return { kind: "preset", preset: value };
  if (name === "icons" && isIconMode(value)) return { kind: "icons", iconMode: value };

  return { kind: "usage" };
}

/**
 * The bare command's whole reply: state, then the file to hand-edit, then what
 * else is typeable. The usage belongs here rather than only on a bad argument,
 * because a command that answers a first-time `/statusbar` with three facts and
 * no next step reads as a command that did nothing.
 */
export function describeSettings(config: StatusbarConfig, path: string): string {
  const state = config.enabled ? "on" : "off";
  return [
    `pi-statusbar ${state} · preset ${config.preset} · icons ${config.iconMode}`,
    path,
    "",
    USAGE,
  ].join("\n");
}

/** The title on the first picker. Short: the list underneath says the rest. */
export const MENU_TITLE = "pi-statusbar";

export interface MenuOption {
  readonly label: string;
  readonly command: StatusbarCommand;
}

/**
 * One row of the picker. A row with several options opens a second picker
 * titled with the row's own label; a row with exactly one applies it straight
 * away. That is the whole menu grammar, so there is no submenu type and no
 * branching in the data.
 */
export interface MenuEntry {
  readonly label: string;
  readonly options: readonly MenuOption[];
}

/** Rows carry the value they would change, so the picker doubles as a read. */
export function buildMenu(config: StatusbarConfig): readonly MenuEntry[] {
  const toggle = config.enabled ? "Turn the footer off" : "Turn the footer on";
  return [
    {
      label: `Layout preset · ${config.preset}`,
      options: PRESET_VALUES.map((preset) => ({
        label: preset,
        command: { kind: "preset", preset } as const,
      })),
    },
    {
      label: `Icon set · ${config.iconMode}`,
      options: ICON_MODE_VALUES.map((iconMode) => ({
        label: iconMode,
        command: { kind: "icons", iconMode } as const,
      })),
    },
    {
      label: toggle,
      options: [{ label: toggle, command: { kind: "enabled", enabled: !config.enabled } }],
    },
    {
      label: "Reset to defaults",
      options: [{ label: "Reset to defaults", command: { kind: "reset" } }],
    },
    {
      label: "Show settings and config path",
      options: [{ label: "Show", command: { kind: "show" } }],
    },
  ];
}

export interface StatusbarCommandHost {
  /** The config as it currently stands in memory. */
  current(): StatusbarConfig;
  /** Apply in memory, repaint, then persist. Reports a failed write itself. */
  commit(next: StatusbarConfig, ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Walks the picker. Cancelling either level returns undefined and commits
 * nothing, which is the same escape at both depths.
 */
async function chooseFromMenu(
  config: StatusbarConfig,
  ctx: ExtensionCommandContext,
): Promise<StatusbarCommand | undefined> {
  const menu = buildMenu(config);
  const chosen = await ctx.ui.select(
    MENU_TITLE,
    menu.map((entry) => entry.label),
  );
  const entry = menu.find((candidate) => candidate.label === chosen);
  if (!entry) return undefined;

  const [only] = entry.options;
  if (only && entry.options.length === 1) return only.command;

  const picked = await ctx.ui.select(
    entry.label,
    entry.options.map((option) => option.label),
  );
  return entry.options.find((option) => option.label === picked)?.command;
}

async function applyCommand(
  command: StatusbarCommand,
  host: StatusbarCommandHost,
  ctx: ExtensionCommandContext,
): Promise<void> {
  switch (command.kind) {
    case "show":
      ctx.ui.notify(describeSettings(host.current(), getConfigPath()), "info");
      return;
    case "usage":
      ctx.ui.notify(USAGE, "warning");
      return;
    case "preset":
      // configWithPreset carries the icon mode across untouched. A font
      // capability belongs to the terminal, not to a layout, so an explicit
      // icons choice outlives every later preset switch.
      await host.commit(configWithPreset(host.current(), command.preset), ctx);
      ctx.ui.notify(`pi-statusbar preset: ${command.preset}`, "info");
      return;
    case "icons":
      await host.commit({ ...host.current(), iconMode: command.iconMode }, ctx);
      ctx.ui.notify(`pi-statusbar icons: ${command.iconMode}`, "info");
      return;
    case "enabled":
      await host.commit({ ...host.current(), enabled: command.enabled }, ctx);
      ctx.ui.notify(`pi-statusbar ${command.enabled ? "enabled" : "disabled"}`, "info");
      return;
    case "reset":
      await host.commit(cloneConfig(DEFAULT_CONFIG), ctx);
      ctx.ui.notify("pi-statusbar reset to defaults", "info");
  }
}

export function registerStatusbarCommand(pi: ExtensionAPI, host: StatusbarCommandHost): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show or change the pi-statusbar footer",
    handler: async (args, ctx) => {
      // The bare command opens the picker, which is what anyone types first.
      // Typed arguments keep working and skip it entirely, and a run with no
      // terminal to draw in falls back to the text the picker would have shown.
      if (args.trim().length === 0) {
        if (!ctx.hasUI) {
          await applyCommand({ kind: "show" }, host, ctx);
          return;
        }
        const chosen = await chooseFromMenu(host.current(), ctx);
        if (chosen) await applyCommand(chosen, host, ctx);
        return;
      }

      await applyCommand(parseStatusbarCommand(args), host, ctx);
    },
  });
}
