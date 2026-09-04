import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ColorLevel } from "../colors.js";
import type { ColorScheme } from "../schemes.js";
import type { IconMode, StatusbarData, WidgetEntry, WidgetOptions, WidgetStyle } from "../types.js";

/**
 * One glyph per icon mode. pi-footer carries a third, `text`, holding word
 * labels; it went with the preset that used it. Two modes means the type makes
 * an unhandled mode impossible rather than merely unlikely.
 */
export interface WidgetIconSet {
  emoji: string;
  nerd: string;
}

export type PropertyKind = "boolean" | "number" | "choice" | "text";

export type WidgetPropertyDefault = string | number | boolean;

/**
 * A widget-specific option. pi-footer carries a label, a description, a
 * showWhen guard and a bag of showIn* flags on every one of these; all of it
 * existed to lay out the config UI's field editors and pickers. What survives
 * is what the sanitizer needs to validate a hand-edited config file.
 */
export interface WidgetProperty {
  id: string;
  kind: PropertyKind;
  default: WidgetPropertyDefault;
  /** Clamp bounds, for number kinds. */
  min?: number;
  max?: number;
  /** Accepted values, for choice kinds. */
  choices?: readonly string[];
}

export type WidgetBaseOption = "raw" | "hideWhenEmpty" | "hideWhenZero" | "text" | "icon";

export interface WidgetRenderOptions extends WidgetStyle {
  icons?: WidgetIconSet;
  preservedTrimStyles?: string;
  stripIncomingStyles?: boolean;
}

export type WidgetDependency = keyof StatusbarData;

export interface BaseWidgetContext {
  iconMode: IconMode;
  colorLevel: ColorLevel;
  theme?: Theme;
  /** Absent at the "default" setting, which is what makes a scheme opt-in. */
  scheme?: ColorScheme;
}

export type WidgetContext<TDeps extends readonly WidgetDependency[] = readonly []> =
  BaseWidgetContext & Pick<StatusbarData, TDeps[number]>;

export type WidgetInstanceOptions<TOptions extends object> = WidgetOptions & TOptions;

export interface Widget<TOptions extends object = {}> {
  readonly entry: WidgetEntry;
  readonly id: string;
  readonly type: WidgetEntry["type"];
  enabled: boolean;
  options: WidgetInstanceOptions<TOptions>;

  render(ctx: WidgetContext): string | undefined;
  toggle(enabled?: boolean): void;
  update(options: Partial<WidgetInstanceOptions<TOptions>>): void;
  toEntry(): WidgetEntry;
}

type BaseOptionsToObject<TBaseOptions extends readonly WidgetBaseOption[]> = Required<
  Pick<WidgetOptions, TBaseOptions[number]>
>;

type WidgetChoiceValue<TProperty> = TProperty extends {
  readonly kind: "choice";
  readonly choices: readonly (infer TChoice extends string)[];
}
  ? TChoice
  : string;

type WidgetPropertyValue<TProperty extends Pick<WidgetProperty, "kind">> =
  TProperty["kind"] extends "boolean"
    ? boolean
    : TProperty["kind"] extends "number"
      ? number
      : TProperty["kind"] extends "choice"
        ? WidgetChoiceValue<TProperty>
        : string;

type PropertiesToObject<TProperties extends readonly WidgetProperty[]> = {
  [TProperty in TProperties[number] as TProperty["id"]]: WidgetPropertyValue<TProperty>;
};

export type OptionsFor<TSpec extends Pick<WidgetSpec, "baseOptions" | "properties">> =
  WidgetOptions &
    BaseOptionsToObject<TSpec["baseOptions"]> &
    PropertiesToObject<TSpec["properties"]> &
    WidgetStyle;

export type ContextFor<TSpec extends Pick<WidgetSpec, "dependencies">> = BaseWidgetContext &
  Pick<StatusbarData, TSpec["dependencies"][number]>;

export interface TypedWidgetRenderArgs<
  TSpec extends Pick<WidgetSpec, "dependencies" | "baseOptions" | "properties">,
> {
  readonly ctx: ContextFor<TSpec>;
  readonly options: OptionsFor<TSpec>;
  readonly renderWidget: (
    value: string | undefined,
    renderOptions?: WidgetRenderOptions,
  ) => string | undefined;
}

export interface WidgetSpec<
  TType extends string = string,
  TDependencies extends readonly WidgetDependency[] = readonly WidgetDependency[],
  TBaseOptions extends readonly WidgetBaseOption[] = readonly WidgetBaseOption[],
  TProperties extends readonly WidgetProperty[] = readonly WidgetProperty[],
> {
  readonly type: TType;
  /** One line on what the widget shows. The only in-source answer for someone editing the JSON. */
  readonly description: string;
  readonly dependencies: TDependencies;
  readonly baseOptions: TBaseOptions;
  readonly baseOptionDefaults?: Partial<WidgetOptions>;
  readonly properties: TProperties;
  readonly icons: WidgetIconSet;
  readonly defaultStyle: WidgetStyle;
  render(
    args: TypedWidgetRenderArgs<{
      readonly dependencies: TDependencies;
      readonly baseOptions: TBaseOptions;
      readonly properties: TProperties;
    }>,
  ): string | undefined;
}

export function defineWidget<
  const TType extends string,
  const TDependencies extends readonly WidgetDependency[],
  const TBaseOptions extends readonly WidgetBaseOption[],
  const TProperties extends readonly WidgetProperty[],
>(
  spec: WidgetSpec<TType, TDependencies, TBaseOptions, TProperties>,
): WidgetSpec<TType, TDependencies, TBaseOptions, TProperties> {
  return spec;
}
