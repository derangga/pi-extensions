import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingsListTheme, Text } from "@earendil-works/pi-tui";

import {
  cloneConfig,
  configWithPreset,
  DEFAULT_CONFIG,
  getConfigPath,
  isIconMode,
  isPreset,
  isSeparatorStyle,
} from "./config.js";
import {
  buildPanelItems,
  buildSettingItems,
  commandForSettingChange,
  cycleValue,
  isActionRow,
  stepForKey,
} from "./panel.js";
import type { Preset } from "./presets.js";
import { normalizeColorSchemeName, type ColorSchemeName } from "./schemes.js";
import { SEPARATOR_VALUES, type SeparatorStyle } from "./separators.js";
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
  `  /statusbar separator <${SEPARATOR_VALUES.join("|")}>`,
  "  /statusbar icons <emoji|nerd>                 switch icon set",
  // <scheme> rather than the twelve names. The separator line above already
  // spells its seven inline and is at the limit of what fits in 80 columns.
  "  /statusbar colors <scheme>                    the panel lists every scheme",
  "  /statusbar on | off                           show or hide the footer",
  "  /statusbar reset                              restore defaults",
].join("\n");

export type StatusbarCommand =
  | { kind: "show" }
  | { kind: "preset"; preset: Preset }
  | { kind: "separator"; separator: SeparatorStyle }
  | { kind: "icons"; iconMode: IconMode }
  | { kind: "colors"; colorScheme: ColorSchemeName }
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
  if (name === "separator" && isSeparatorStyle(value))
    return { kind: "separator", separator: value };
  if (name === "colors") {
    // Named colors, not theme. The word theme belongs to the Pi-wide setting
    // in /settings, which this feature does not touch.
    const colorScheme = normalizeColorSchemeName(value);
    if (colorScheme) return { kind: "colors", colorScheme };
  }

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
    `pi-statusbar ${state} · preset ${config.preset} · separator ${config.separator} · icons ${config.iconMode}`,
    // Its own line. Appended to the one above, the longest scheme name would
    // push that line past 80 columns and wrap it.
    `colors ${config.colorScheme}`,
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
 * The one thing the rows cannot do, printed directly under SettingsList's own
 * hint. Nothing about the keys: the list already names Enter, Space and Esc,
 * and a second line naming the arrows only raises the question of which of the
 * two ways to change a value is the real one.
 */
export const PANEL_HINT = "/statusbar reset restores defaults";

export const PANEL_TITLE = "pi-statusbar";

/**
 * Matches SettingsList's own hint exactly: its two-space indent, its hint
 * colour, and no padding, so the two lines read as one block rather than as a
 * hint and some other thing below it.
 */
function hintLine(settingsTheme: SettingsListTheme): Text {
  return new Text(settingsTheme.hint(`  ${PANEL_HINT}`), 0, 0);
}

/**
 * Opens the panel. Each row applies as it changes, so the config on disk is
 * always what the rows say and closing the panel saves nothing further. Dismiss
 * and escape both just close it; `/statusbar reset` is the way back.
 */
async function openPanel(
  host: StatusbarCommandHost,
  ctx: ExtensionCommandContext,
  apply: (command: StatusbarCommand) => Promise<void>,
): Promise<void> {
  const items = buildPanelItems(host.current());
  let cursor = 0;

  await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", PANEL_TITLE), 1, 1));

    const settingsTheme = getSettingsListTheme();
    const list = new SettingsList(
      items,
      items.length,
      settingsTheme,
      (id, value) => {
        const command = commandForSettingChange(id, value);
        if (command) applyAndSync(command);
      },
      () => done(undefined),
    );
    container.addChild(list);
    container.addChild(hintLine(settingsTheme));

    /**
     * Puts every row back in step with the config after a change. A preset
     * carries its own separator, so moving the preset row rewrites a value
     * another row is displaying, and without this that row would go on showing
     * a separator the config no longer holds.
     */
    const syncRows = (): void => {
      for (const fresh of buildSettingItems(host.current())) {
        list.updateValue(fresh.id, fresh.currentValue);
      }
    };

    const applyAndSync = (command: StatusbarCommand): void => {
      void apply(command).then(() => {
        syncRows();
        tui.requestRender();
      });
    };

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
        const item = items[cursor];
        const step = stepForKey(data);

        if (step !== undefined) {
          if (item?.values) {
            const value = cycleValue(item.values, item.currentValue, step);
            // updateValue writes through to this same item: SettingsList holds
            // the array, it does not copy it. So this is the only assignment
            // needed, and item.currentValue reads back the new value.
            list.updateValue(item.id, value);
            const command = commandForSettingChange(item.id, value);
            if (command) applyAndSync(command);
          }
          tui.requestRender();
          return;
        }

        // A closing row carries no values, so SettingsList would do nothing
        // with the keypress. Taking it here is what makes the row an action.
        if (item && isActionRow(item.id) && keybindings.matches(data, "tui.select.confirm")) {
          done(undefined);
          return;
        }

        // Up, down and escape are all the list's own. Its cursor is private, so
        // the same keypress moves this one too, and it is read through the
        // keybindings manager rather than as a hardcoded escape sequence: a
        // user who has bound j and k must not end up moving one cursor and
        // changing another row's value.
        list.handleInput?.(data);
        if (keybindings.matches(data, "tui.select.up")) move(-1);
        else if (keybindings.matches(data, "tui.select.down")) move(1);
        tui.requestRender();
      },
    };
  });
}

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
    case "separator":
      await host.commit({ ...host.current(), separator: command.separator }, ctx);
      say(`pi-statusbar separator: ${command.separator}`, "info");
      return;
    case "colors":
      await host.commit({ ...host.current(), colorScheme: command.colorScheme }, ctx);
      say(`pi-statusbar colors: ${command.colorScheme}`, "info");
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
