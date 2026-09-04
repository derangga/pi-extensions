import type { SeparatorStyle } from "./separators.js";
import type { WidgetOptions } from "./types.js";
import type { WidgetType } from "./widgets/registry.js";

export interface PresetWidget {
  type: WidgetType;
  options?: WidgetOptions;
}

export interface PresetDefinition {
  separator: SeparatorStyle;
  lines: PresetWidget[][];
}

function widget(type: WidgetType, options: WidgetOptions = {}): PresetWidget {
  return { type, options };
}

/**
 * pi-footer's three plain layouts, with its verbosity segment dropped.
 *
 * A preset carries a separator and a widget list, and deliberately no icon
 * mode. Upstream lets git-heavy force nerd icons, which overwrites the user's
 * choice on a preset switch; here a font capability belongs to the terminal
 * rather than to a layout.
 */
export const PRESET_DEFINITIONS = {
  default: {
    separator: "dot",
    lines: [
      [
        widget("model-provider"),
        widget("thinking-level"),
        widget("context-length"),
        widget("git-branch"),
        widget("git-diff", { gitDiffMode: "compact" }),
        widget("cost"),
        widget("total-time"),
      ],
    ],
  },
  compact: {
    separator: "space",
    lines: [
      [
        widget("model"),
        widget("thinking-level"),
        widget("git-branch"),
        widget("context"),
        widget("cost"),
      ],
    ],
  },
  "git-heavy": {
    separator: "dot",
    lines: [
      [
        widget("model-provider"),
        widget("cwd-basename"),
        widget("git-branch"),
        widget("git-sha"),
        widget("git-status"),
        widget("git-diff", { gitDiffMode: "compact" }),
        widget("git-ahead-behind"),
      ],
    ],
  },
} satisfies Record<string, PresetDefinition>;

export type Preset = keyof typeof PRESET_DEFINITIONS;

export const PRESET_VALUES = Object.keys(PRESET_DEFINITIONS) as readonly Preset[];
