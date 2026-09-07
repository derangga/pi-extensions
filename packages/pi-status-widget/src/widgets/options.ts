import { normalizeColor } from "../colors.js";
import type { WidgetOptions } from "../types.js";
import type { WidgetProperty, WidgetPropertyDefault, WidgetSpec } from "./types.js";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

const SYSTEM_BASE_OPTION_DEFAULTS = {
  raw: false,
  hideWhenEmpty: false,
  hideWhenZero: false,
  text: "-",
  icon: "",
} as const;

/** Property ids that hold a color even though their kind is text. */
const COLOR_VALUED_PROPERTIES = new Set(["warningFg", "warningBg", "dangerFg", "dangerBg"]);

// The options-relevant slice of a spec. Excludes render so concrete widget specs stay
// assignable: render's generic parameters make the full spec invariant.
type WidgetOptionsSpec = Pick<
  WidgetSpec,
  "baseOptions" | "baseOptionDefaults" | "properties" | "defaultStyle"
>;

export function defaultOptionsFromSpec(spec: WidgetOptionsSpec): WidgetOptions {
  const base: WidgetOptions = {};

  for (const option of spec.baseOptions) {
    const optionId: string = option;
    base[optionId] = SYSTEM_BASE_OPTION_DEFAULTS[option];
  }
  Object.assign(base, spec.baseOptionDefaults ?? {});

  for (const property of spec.properties) {
    base[property.id] = property.default;
  }

  if (spec.defaultStyle.fg !== undefined) {
    base.fg = spec.defaultStyle.fg;
  }
  if (spec.defaultStyle.bg !== undefined) {
    base.bg = spec.defaultStyle.bg;
  }
  if (spec.defaultStyle.bold !== undefined) {
    base.bold = spec.defaultStyle.bold;
  }

  return base;
}

/**
 * Takes whatever a config file or a preset offers and returns options the
 * renderer can trust: every declared key present, every value the right type,
 * every unknown key dropped. This is the only validation a hand-edited config
 * gets, since the package ships no UI to produce a well-formed one.
 */
export function sanitizeOptionsFromSpec(
  spec: WidgetOptionsSpec,
  input: Record<string, unknown>,
): WidgetOptions {
  const defaults = defaultOptionsFromSpec(spec);
  const merged: Record<string, unknown> = { ...defaults, ...input } as Record<string, unknown>;
  const next: WidgetOptions = {};

  for (const option of spec.baseOptions) {
    if (!(option in defaults)) {
      continue;
    }
    const optionId: string = option;
    next[optionId] = sanitizeBaseOption(merged[optionId], defaults[optionId]);
  }

  // A color that fails to normalize falls back to the spec's default rather than
  // vanishing, so a typo in a hand-edited file behaves like every other bad
  // value here. A widget that declares no default keeps the key absent.
  // SAFETY: merged values are validated via normalizeColor at boundary; defaults are ColorName-typed
  const fg = normalizeColor(merged.fg as unknown) ?? normalizeColor(defaults.fg);
  if (fg) {
    next.fg = fg;
  }
  const bg = normalizeColor(merged.bg as unknown) ?? normalizeColor(defaults.bg);
  if (bg) {
    next.bg = bg;
  }
  next.bold = isBoolean(merged.bold) ? merged.bold : Boolean(defaults.bold);

  for (const property of spec.properties) {
    next[property.id] = sanitizeProperty(property, merged[property.id]);
  }

  return next;
}

function sanitizeProperty(property: WidgetProperty, value: unknown): string | number | boolean {
  switch (property.kind) {
    case "boolean":
      return isBoolean(value) ? value : property.default;
    case "number":
      return clampNumber(value, property.default, property.min, property.max);
    case "text":
      if (COLOR_VALUED_PROPERTIES.has(property.id)) {
        return normalizeColor(value) ?? property.default;
      }
      return isString(value) ? value : property.default;
    case "choice": {
      const choices = property.choices ?? [];
      return isString(value) && choices.includes(value) ? value : property.default;
    }
  }
}

function sanitizeBaseOption(
  value: unknown,
  defaultValue: WidgetOptions[keyof WidgetOptions],
): WidgetOptions[keyof WidgetOptions] {
  if (isBoolean(defaultValue)) {
    return isBoolean(value) ? value : defaultValue;
  }
  if (isNumber(defaultValue)) {
    return isNumber(value) && Number.isInteger(value) ? value : defaultValue;
  }
  if (isString(defaultValue)) {
    return isString(value) ? value : defaultValue;
  }
  return defaultValue;
}

function clampNumber(
  value: unknown,
  defaultValue: WidgetPropertyDefault,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const numberValue = isNumber(value) && Number.isInteger(value) ? value : defaultValue;
  const safeNumber = isNumber(numberValue) ? numberValue : 0;
  return Math.min(max, Math.max(min, safeNumber));
}
