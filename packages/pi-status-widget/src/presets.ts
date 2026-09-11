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
 * Four plain layouts with the verbosity segment omitted.
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
  /**
   * The only preset that is two lines. Where it goes matters: everything
   * changes on the working directory sits above everything that changes on the
   * model, so neither row reshuffles when the other does.
   *
   * Keyed "2-lines" rather than "2 lines" because parseStatusbarCommand splits
   * its arguments on whitespace. A space would make `/statusbar preset 2 lines`
   * read the value as "2", fail isPreset, and print usage.
   */
  "2-lines": {
    separator: "dot",
    lines: [
      [widget("cwd-basename"), widget("git-branch")],
      [widget("model"), widget("thinking-level"), widget("context"), widget("cost")],
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
