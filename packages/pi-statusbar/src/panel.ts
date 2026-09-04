/**
 * The `/statusbar` panel: three rows whose values change under the left and
 * right arrows, applied the moment they change so the real footer redraws
 * behind the panel.
 *
 * pi-tui's SettingsList already draws label-and-value rows and cycles a value
 * on Enter, but it binds no left or right arrow and keeps its cursor private.
 * So the arrows are handled here and the cursor is mirrored back into the list
 * through selectItem, which is public.
 */

import type { SettingItem } from "@earendil-works/pi-tui";

import type { StatusbarCommand } from "./command.js";
import { PRESET_VALUES, type Preset } from "./presets.js";
import { ICON_MODE_VALUES, type IconMode, type StatusbarConfig } from "./types.js";

export const ROW_PRESET = "preset";
export const ROW_ICONS = "icons";
export const ROW_ENABLED = "enabled";

const ON = "on";
const OFF = "off";

/**
 * Steps for the arrow keys. Both encodings, because a terminal in application
 * cursor mode sends ESC O D where the normal mode sends ESC [ D, and pi-tui
 * binds no keybinding id for either.
 */
const STEP_FOR_KEY: Record<string, number> = {
  "\u001b[D": -1,
  "\u001b[C": 1,
  "\u001bOD": -1,
  "\u001bOC": 1,
};

export function stepForKey(data: string): number | undefined {
  return STEP_FOR_KEY[data];
}

/** Wraps in both directions, so neither arrow ever dead-ends on a row. */
export function cycleValue(values: readonly string[], current: string, step: number): string {
  if (values.length === 0) return current;
  const at = values.indexOf(current);
  // An unknown current value starts the walk at the first entry rather than
  // treating -1 as a position, which would skip an entry going right.
  const from = at === -1 ? 0 : at;
  const next = (from + step + values.length) % values.length;
  return values[next] ?? current;
}

export function buildSettingItems(config: StatusbarConfig): SettingItem[] {
  return [
    {
      id: ROW_PRESET,
      label: "Layout preset",
      currentValue: config.preset,
      values: [...PRESET_VALUES],
    },
    {
      id: ROW_ICONS,
      label: "Icon set",
      currentValue: config.iconMode,
      values: [...ICON_MODE_VALUES],
    },
    {
      id: ROW_ENABLED,
      label: "Footer",
      currentValue: config.enabled ? ON : OFF,
      values: [ON, OFF],
    },
  ];
}

/**
 * Turns a row's new value back into an intent. Returns undefined for anything
 * the rows cannot produce, so a stray value commits nothing rather than a
 * default.
 */
export function commandForSettingChange(id: string, value: string): StatusbarCommand | undefined {
  if (id === ROW_PRESET) {
    return PRESET_VALUES.includes(value as Preset)
      ? { kind: "preset", preset: value as Preset }
      : undefined;
  }
  if (id === ROW_ICONS) {
    return ICON_MODE_VALUES.includes(value as IconMode)
      ? { kind: "icons", iconMode: value as IconMode }
      : undefined;
  }
  if (id === ROW_ENABLED && (value === ON || value === OFF)) {
    return { kind: "enabled", enabled: value === ON };
  }
  return undefined;
}
