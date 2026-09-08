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
 * Three plain layouts with the verbosity segment omitted.
 *
 * A preset carries a separator and a widget list, and deliberately no icon
 * mode. A font capability belongs to the terminal rather than to a layout, so
 * a preset switch does not overwrite the user's icon choice.
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

// SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
export const PRESET_VALUES = Object.keys(PRESET_DEFINITIONS) as readonly Preset[];
