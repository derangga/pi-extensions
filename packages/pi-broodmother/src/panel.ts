import type { SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";

import {
  INHERIT,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TURNS,
  MIN_CONCURRENCY,
  MIN_TASKS,
  MIN_TURNS,
  type SubagentSettings,
  type ThinkingChoice,
} from "./settings.js";
import { supportedThinkingLevels, type PiModel } from "./thinking.js";

/** What Pi's SettingsList puts in its footer, and what this panel puts there. */
export const CANCEL_HINT = "Esc to cancel";
export const DISMISS_HINT = "Esc to dismiss";

/**
 * Corrects the footer. Every row here commits as it changes, so Esc closes the
 * panel and keeps what you picked; "cancel" promises it reverts, which it does
 * not. Pi's SettingsList hardcodes that line, and the theme's `hint` is the one
 * place the text passes through on its way to the screen, so it is rewritten
 * there. The three other strings Pi sends through `hint` do not carry the
 * phrase, and an upstream rewording falls through untouched rather than
 * breaking the panel.
 */
export function withDismissHint(theme: SettingsListTheme): SettingsListTheme {
  return {
    ...theme,
    hint: (text: string) => theme.hint(text.replaceAll(CANCEL_HINT, DISMISS_HINT)),
  };
}

export const ROW_MODEL = "model";
export const ROW_THINKING = "thinking";
export const ROW_CONCURRENCY = "concurrency";
export const ROW_MAX_TURNS = "maxTurns";
export const ROW_MAX_TASKS = "maxTasks";

/**
 * The numbers cycle through a fixed list rather than opening an input.
 * `SettingItem` has no numeric row, so the alternatives are a submenu holding
 * one number or free text that then needs its own range check and its own error
 * state. A list of the values anyone would pick costs neither, and the settings
 * file is right there for anything the list does not cover.
 */
export const CONCURRENCY_VALUES = range(MIN_CONCURRENCY, MAX_CONCURRENCY).map(String);
export const MAX_TURNS_VALUES = [10, 20, 30, 50, 75, 100, 150, MAX_TURNS]
  .filter((value) => value >= MIN_TURNS && value <= MAX_TURNS)
  .map(String);
export const MAX_TASKS_VALUES = [1, 2, 3, 4, 6, 8, 12, MAX_TASKS]
  .filter((value) => value >= MIN_TASKS && value <= MAX_TASKS)
  .map(String);

/**
 * The model a subagent would run on if it started now. `inherit` is not a model
 * and cannot be asked what it supports, so it resolves to the parent's.
 */
export function resolveModel(
  settings: SubagentSettings,
  available: readonly PiModel[],
  parent: PiModel | undefined,
): PiModel | undefined {
  if (settings.model === INHERIT) {
    return parent;
  }
  return available.find((model) => model.id === settings.model) ?? parent;
}

/**
 * What the thinking row may offer, given whichever model row one resolves to.
 * An unresolvable model leaves only `inherit`: offering levels against a model
 * nobody can name would be offering a guess.
 */
export function thinkingValues(model: PiModel | undefined): string[] {
  if (!model) {
    return [INHERIT];
  }
  return [INHERIT, ...supportedThinkingLevels(model)];
}

/**
 * Keeps the thinking choice legal after the model row moves. Switching from a
 * reasoning model to one without it must not leave `high` sitting in a row that
 * no longer has a `high` to give.
 */
export function clampThinking(choice: ThinkingChoice, model: PiModel | undefined): ThinkingChoice {
  return thinkingValues(model).includes(choice) ? choice : INHERIT;
}

export function buildSettingItems(
  settings: SubagentSettings,
  available: readonly PiModel[],
  parent: PiModel | undefined,
): SettingItem[] {
  const resolved = resolveModel(settings, available, parent);

  return [
    {
      id: ROW_MODEL,
      label: "Model",
      description: modelDescription(settings, parent),
      currentValue: settings.model,
    },
    {
      id: ROW_THINKING,
      label: "Thinking effort",
      description: resolved
        ? `Levels ${resolved.id} accepts. inherit leaves the per-task choice in charge.`
        : "No model to check against. Pick a model first.",
      currentValue: settings.thinking,
      values: thinkingValues(resolved),
    },
    {
      id: ROW_CONCURRENCY,
      label: "Concurrency",
      description: "How many children run at once.",
      currentValue: String(settings.concurrency),
      values: CONCURRENCY_VALUES,
    },
    {
      id: ROW_MAX_TURNS,
      label: "Max turns",
      description: "Turn budget per child before it is asked to wrap up.",
      currentValue: String(settings.maxTurns),
      values: MAX_TURNS_VALUES,
    },
    {
      id: ROW_MAX_TASKS,
      label: "Max tasks",
      description: "Most children one call may spawn. Over it, the call is refused.",
      currentValue: String(settings.maxTasks),
      values: MAX_TASKS_VALUES,
    },
  ];
}

/**
 * Applies one row's new value. Returns the settings unchanged when the value
 * makes no sense for the row, so a malformed change from the list is a no-op
 * rather than a half-applied setting.
 */
export function settingsWithRowChange(
  settings: SubagentSettings,
  id: string,
  value: string,
  available: readonly PiModel[],
  parent: PiModel | undefined,
): SubagentSettings {
  switch (id) {
    case ROW_MODEL: {
      const next = { ...settings, model: value };
      // The thinking row is recomputed against the new model, so a level the
      // new model cannot take is dropped here rather than saved and rejected
      // later by a child that has already started.
      return {
        ...next,
        thinking: clampThinking(settings.thinking, resolveModel(next, available, parent)),
      };
    }
    case ROW_THINKING:
      return thinkingValues(resolveModel(settings, available, parent)).includes(value)
        ? { ...settings, thinking: value as ThinkingChoice }
        : settings;
    case ROW_CONCURRENCY:
      return withNumber(settings, "concurrency", value, MIN_CONCURRENCY, MAX_CONCURRENCY);
    case ROW_MAX_TURNS:
      return withNumber(settings, "maxTurns", value, MIN_TURNS, MAX_TURNS);
    case ROW_MAX_TASKS:
      return withNumber(settings, "maxTasks", value, MIN_TASKS, MAX_TASKS);
    default:
      return settings;
  }
}

/** The bare command's reply, and what the panel falls back to with no terminal. */
export function describeSettings(settings: SubagentSettings, path: string): string {
  return [
    `model ${settings.model} · thinking ${settings.thinking} · concurrency ${settings.concurrency} · max turns ${settings.maxTurns} · max tasks ${settings.maxTasks}`,
    path,
  ].join("\n");
}

export function cycleValue(values: readonly string[], current: string, step: number): string {
  if (values.length === 0) {
    return current;
  }
  const index = values.indexOf(current);
  const next = ((index === -1 ? 0 : index) + step + values.length) % values.length;
  return values[next] ?? current;
}

function modelDescription(settings: SubagentSettings, parent: PiModel | undefined): string {
  if (settings.model !== INHERIT) {
    return "Every child runs on this, whatever a task asks for.";
  }
  return parent
    ? `Follows the parent, currently ${parent.id}.`
    : "Follows the parent. No parent model is set.";
}

function withNumber(
  settings: SubagentSettings,
  key: "concurrency" | "maxTurns" | "maxTasks",
  value: string,
  minimum: number,
  maximum: number,
): SubagentSettings {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return settings;
  }
  return { ...settings, [key]: parsed };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
