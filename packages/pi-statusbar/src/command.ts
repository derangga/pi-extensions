import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  getConfigPath,
  isIconMode,
  isPreset,
} from "./config.js";
import type { Preset } from "./presets.js";
import type { IconMode, StatusbarConfig } from "./types.js";

export const COMMAND_NAME = "statusbar";

/**
 * The whole config surface, in place of pi-footer's 26-file terminal editor.
 * Three presets is a small enough space that a picker beats a builder, and the
 * file path is on the first line because hand-editing is the way to reach
 * anything this command does not cover.
 */
export const USAGE = [
  "Usage:",
  "  /statusbar                                    show current settings",
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

export interface StatusbarCommandHost {
  /** The config as it currently stands in memory. */
  current(): StatusbarConfig;
  /** Apply in memory, repaint, then persist. Reports a failed write itself. */
  commit(next: StatusbarConfig, ctx: ExtensionCommandContext): Promise<void>;
}

export function registerStatusbarCommand(pi: ExtensionAPI, host: StatusbarCommandHost): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show or change the pi-statusbar footer",
    handler: async (args, ctx) => {
      const command = parseStatusbarCommand(args);

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
    },
  });
}
