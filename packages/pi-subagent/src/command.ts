import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, type SelectItem, SettingsList, Text } from "@earendil-works/pi-tui";

import {
  buildSettingItems,
  cycleValue,
  describeSettings,
  ROW_MODEL,
  ROW_THINKING,
  settingsWithRowChange,
  thinkingValues,
  resolveModel,
} from "./panel.js";
import { INHERIT, type SubagentSettings } from "./settings.js";
import type { PiModel } from "./thinking.js";

export const COMMAND_NAME = "subagent";

export const USAGE = [
  "Usage:",
  "  /subagent            open the settings panel",
  "  /subagent settings   the same panel, spelled out",
].join("\n");

export const PANEL_TITLE = "pi-subagent";

/**
 * What the panel cannot say for itself. The file path earns its line because
 * hand-editing is the way to reach a value the rows do not offer.
 */
export function panelHint(path: string): string {
  return `settings file: ${path}`;
}

export interface SubagentCommandHost {
  /** The settings as they currently stand in memory. */
  current(): SubagentSettings;
  /** The file the settings came from. */
  path(): string;
  /** Everything wrong with that file at load, reported once on first open. */
  takeWarnings(): readonly string[];
  /** Apply in memory, then persist. Reports a failed write itself. */
  commit(next: SubagentSettings, ctx: ExtensionCommandContext): Promise<void>;
}

/**
 * Opens the panel. Every row applies as it changes, so what is on disk is
 * always what the rows say and closing saves nothing further.
 */
async function openPanel(host: SubagentCommandHost, ctx: ExtensionCommandContext): Promise<void> {
  const available = ctx.modelRegistry.getAvailable();
  const parent = ctx.model;

  const items = buildSettingItems(host.current(), available, parent);
  let cursor = 0;
  /**
   * Set while the model picker is open. Without it the panel goes on taking the
   * arrows for itself, moving a cursor nobody can see behind the picker.
   */
  let submenuOpen = false;

  await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", PANEL_TITLE), 1, 1));

    const settingsTheme = getSettingsListTheme();
    const list = new SettingsList(
      items,
      items.length,
      settingsTheme,
      (id, value) => applyAndSync(id, value),
      () => done(undefined),
    );
    container.addChild(list);
    container.addChild(new Text(settingsTheme.hint(`  ${panelHint(host.path())}`), 0, 0));

    const modelRow = items.find((item) => item.id === ROW_MODEL);
    if (modelRow) {
      modelRow.submenu = (opened, close) => {
        submenuOpen = true;
        const picker = new SelectList(
          modelChoices(available, parent),
          Math.min(12, available.length + 1),
          getSelectListTheme(),
        );
        picker.setSelectedIndex(Math.max(0, indexOfChoice(available, opened)));
        picker.onSelect = (item) => {
          submenuOpen = false;
          // close() with a value is what makes SettingsList fire onChange,
          // which is the single commit for this row.
          close(item.value);
          tui.requestRender();
        };
        picker.onCancel = () => {
          submenuOpen = false;
          close();
          tui.requestRender();
        };
        return picker;
      };
    }

    /**
     * Puts every row back in step after a change. The model row rewrites what
     * the thinking row may offer, and `updateValue` only carries a value, so
     * the values array is assigned through the same object SettingsList holds.
     */
    const syncRows = (): void => {
      const settings = host.current();
      const resolved = resolveModel(settings, available, parent);
      for (const fresh of buildSettingItems(settings, available, parent)) {
        list.updateValue(fresh.id, fresh.currentValue);
        const row = items.find((item) => item.id === fresh.id);
        if (row && fresh.description !== undefined) row.description = fresh.description;
      }
      const thinkingRow = items.find((item) => item.id === ROW_THINKING);
      if (thinkingRow) thinkingRow.values = thinkingValues(resolved);
    };

    const applyAndSync = (id: string, value: string): void => {
      const next = settingsWithRowChange(host.current(), id, value, available, parent);
      void host.commit(next, ctx).then(() => {
        syncRows();
        tui.requestRender();
      });
    };

    /** Mirrors my cursor into the list, whose own index is private. */
    const move = (step: number): void => {
      cursor = (cursor + step + items.length) % items.length;
      const item = items[cursor];
      if (item) list.selectItem(item.id);
    };

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Everything belongs to the picker while it is open.
        if (submenuOpen) {
          list.handleInput?.(data);
          tui.requestRender();
          return;
        }

        const item = items[cursor];
        const step = stepForKey(data, keybindings);

        if (step !== undefined && item?.values) {
          const value = cycleValue(item.values, item.currentValue, step);
          // updateValue writes through to this same item: SettingsList holds
          // the array, it does not copy it.
          list.updateValue(item.id, value);
          applyAndSync(item.id, value);
          tui.requestRender();
          return;
        }

        list.handleInput?.(data);
        if (keybindings.matches(data, "tui.select.up")) move(-1);
        else if (keybindings.matches(data, "tui.select.down")) move(1);
        tui.requestRender();
      },
    };
  });
}

/** Left and right cycle a row's values. Up and down belong to the list. */
function stepForKey(
  data: string,
  keybindings: { matches(data: string, id: string): boolean },
): number | undefined {
  if (keybindings.matches(data, "tui.select.left")) return -1;
  if (keybindings.matches(data, "tui.select.right")) return 1;
  return undefined;
}

export function modelChoices(
  available: readonly PiModel[],
  parent: PiModel | undefined,
): SelectItem[] {
  return [
    {
      value: INHERIT,
      label: INHERIT,
      description: parent ? `follow the parent, currently ${parent.id}` : "follow the parent",
    },
    ...available.map((model) => ({
      value: model.id,
      label: model.id,
      description: `${model.provider}${model.reasoning ? " · reasoning" : ""}`,
    })),
  ];
}

function indexOfChoice(available: readonly PiModel[], choice: string): number {
  if (choice === INHERIT) return 0;
  const index = available.findIndex((model) => model.id === choice);
  return index === -1 ? 0 : index + 1;
}

export function registerSubagentCommand(pi: ExtensionAPI, host: SubagentCommandHost): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show or change pi-subagent settings",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();

      if (argument.length > 0 && argument !== "settings") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      for (const warning of host.takeWarnings()) {
        ctx.ui.notify(`pi-subagent: ${warning}`, "warning");
      }

      // No terminal to draw in falls back to the text the panel would show.
      if (!ctx.hasUI) {
        ctx.ui.notify(describeSettings(host.current(), host.path()), "info");
        return;
      }

      await openPanel(host, ctx);
    },
  });
}
