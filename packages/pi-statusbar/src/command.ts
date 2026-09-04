import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";

import {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  getConfigPath,
  isIconMode,
  isPreset,
} from "./config.js";
import { buildSettingItems, commandForSettingChange, cycleValue, stepForKey } from "./panel.js";
import type { Preset } from "./presets.js";
import type { IconMode, StatusbarConfig } from "./types.js";

export const COMMAND_NAME = "statusbar";

/**
 * The whole config surface, in place of pi-footer's 26-file terminal editor.
 * Three presets is a small enough space that a panel of rows beats a builder,
 * and the file path is on the first line because hand-editing is the way to
 * reach anything this command does not cover.
 */
export const USAGE = [
  "Usage:",
  "  /statusbar                                    open the settings panel",
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

/**
 * Only what SettingsList's own hint line leaves out. It already names Enter,
 * Space and Esc, and repeating those wrapped the line at 64 columns.
 */
export const PANEL_HINT = "\u2190\u2192 change  ·  /statusbar reset restores defaults";

export const PANEL_TITLE = "pi-statusbar";

/**
 * Opens the panel and applies each change as it happens. Nothing is returned:
 * every row commits through `apply` on the way past, so closing the panel is
 * not a save and escape is not a cancel.
 */
async function openPanel(
  host: StatusbarCommandHost,
  ctx: ExtensionCommandContext,
  apply: (command: StatusbarCommand) => Promise<void>,
): Promise<void> {
  const items = buildSettingItems(host.current());
  let cursor = 0;

  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", PANEL_TITLE), 1, 1));

      const list = new SettingsList(
        items,
        items.length,
        getSettingsListTheme(),
        (id, value) => {
          const command = commandForSettingChange(id, value);
          if (command) void apply(command);
        },
        () => done(undefined),
      );
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", PANEL_HINT), 1, 1));

      /** Moves my cursor and mirrors it into the list, whose own index is private. */
      const move = (step: number): void => {
        cursor = (cursor + step + items.length) % items.length;
        const item = items[cursor];
        if (item) list.selectItem(item.id);
      };

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const step = stepForKey(data);
          if (step === undefined) {
            // Up, down, Enter, space and escape are all the list's own. Its
            // cursor is private, so the same keypress moves this one too, and
            // it is read through the keybindings manager rather than as a
            // hardcoded escape sequence: a user who has bound j and k must not
            // end up moving one cursor and changing the other row's value.
            list.handleInput?.(data);
            if (keybindings.matches(data, "tui.select.up")) move(-1);
            else if (keybindings.matches(data, "tui.select.down")) move(1);
            tui.requestRender();
            return;
          }

          const item = items[cursor];
          if (item?.values) {
            const value = cycleValue(item.values, item.currentValue, step);
            item.currentValue = value;
            list.updateValue(item.id, value);
            const command = commandForSettingChange(item.id, value);
            if (command) void apply(command);
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

/**
 * `quiet` suppresses the confirmation for changes made from the panel, where
 * the row already shows the new value and a notification per arrow press would
 * bury the panel it came from.
 */
async function applyCommand(
  command: StatusbarCommand,
  host: StatusbarCommandHost,
  ctx: ExtensionCommandContext,
  options: { quiet?: boolean } = {},
): Promise<void> {
  const say = (message: string, type: "info" | "warning"): void => {
    if (!options.quiet) ctx.ui.notify(message, type);
  };

  switch (command.kind) {
    case "show":
      say(describeSettings(host.current(), getConfigPath()), "info");
      return;
    case "usage":
      say(USAGE, "warning");
      return;
    case "preset":
      // configWithPreset carries the icon mode across untouched. A font
      // capability belongs to the terminal, not to a layout, so an explicit
      // icons choice outlives every later preset switch.
      await host.commit(configWithPreset(host.current(), command.preset), ctx);
      say(`pi-statusbar preset: ${command.preset}`, "info");
      return;
    case "icons":
      await host.commit({ ...host.current(), iconMode: command.iconMode }, ctx);
      say(`pi-statusbar icons: ${command.iconMode}`, "info");
      return;
    case "enabled":
      await host.commit({ ...host.current(), enabled: command.enabled }, ctx);
      say(`pi-statusbar ${command.enabled ? "enabled" : "disabled"}`, "info");
      return;
    case "reset":
      await host.commit(cloneConfig(DEFAULT_CONFIG), ctx);
      say("pi-statusbar reset to defaults", "info");
  }
}

export function registerStatusbarCommand(pi: ExtensionAPI, host: StatusbarCommandHost): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show or change the pi-statusbar footer",
    handler: async (args, ctx) => {
      // The bare command opens the panel, which is what anyone types first.
      // Typed arguments keep working and skip it entirely, and a run with no
      // terminal to draw in falls back to the text the panel would have shown.
      if (args.trim().length === 0) {
        if (!ctx.hasUI) {
          await applyCommand({ kind: "show" }, host, ctx);
          return;
        }
        await openPanel(host, ctx, (command) => applyCommand(command, host, ctx, { quiet: true }));
        return;
      }

      await applyCommand(parseStatusbarCommand(args), host, ctx);
    },
  });
}
