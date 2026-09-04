import { applyColors, stripAnsi } from "../colors.js";
import type { WidgetEntry, WidgetOptions } from "../types.js";
import type { WidgetSpecUnion } from "./registry.js";
import type {
  BaseWidgetContext,
  ContextFor,
  OptionsFor,
  TypedWidgetRenderArgs,
  Widget,
  WidgetContext,
  WidgetRenderOptions,
} from "./types.js";

export class WidgetInstance<TSpec extends WidgetSpecUnion = WidgetSpecUnion> implements Widget {
  constructor(
    readonly spec: TSpec,
    readonly entry: WidgetEntry,
  ) {}

  get id(): string {
    return this.entry.id;
  }

  get type(): WidgetEntry["type"] {
    return this.entry.type;
  }

  get enabled(): boolean {
    return this.entry.enabled;
  }

  set enabled(value: boolean) {
    this.entry.enabled = value;
  }

  get options(): WidgetOptions {
    return this.entry.options;
  }

  set options(value: WidgetOptions) {
    this.entry.options = value;
  }

  // TODO(widget-spec): remove casts once the render context and hydrated entries preserve
  // concrete spec types.
  render(ctx: WidgetContext): string | undefined {
    // SAFETY: WidgetInstance is constructed only via registry.createWidget with matching spec, so the spec's render signature matches TSpec at runtime
    const spec = this.spec as unknown as TSpec & {
      render(args: TypedWidgetRenderArgs<TSpec>): string | undefined;
    };
    return spec.render({
      ctx: ctx as ContextFor<TSpec>,
      options: this.options as OptionsFor<TSpec>,
      renderWidget: (value, renderOptions) => {
        return renderWidgetValue(this.entry, value, ctx, {
          ...renderOptions,
          icons: renderOptions?.icons ?? this.spec.icons,
        });
      },
    });
  }

  toggle(enabled = !this.enabled): void {
    this.enabled = enabled;
  }

  update(options: Partial<WidgetOptions>): void {
    this.options = { ...this.options, ...options };
  }

  toEntry(): WidgetEntry {
    return {
      id: this.id,
      type: this.type,
      enabled: this.enabled,
      options: { ...this.options },
    };
  }
}

/**
 * The single place icons, the raw escape, the empty and zero guards, and colors
 * are applied. A widget's own render returns a bare value and hands it here, so
 * every segment composes the same way.
 */
function renderWidgetValue(
  entry: WidgetEntry,
  value: string | undefined,
  ctx: BaseWidgetContext,
  renderOptions: WidgetRenderOptions = {},
): string | undefined {
  const options = entry.options;
  if (!entry.enabled) return undefined;

  const rawValue = value ?? "";
  if (rawValue.length === 0 && options.hideWhenEmpty) return undefined;
  if (rawValue === "0" && options.hideWhenZero) return undefined;

  const fallbackValue = rawValue.length === 0 ? (options.text ?? "-") : rawValue;
  const displayValue = renderOptions.stripIncomingStyles ? stripAnsi(fallbackValue) : fallbackValue;
  const label = renderOptions.icons?.[ctx.iconMode];
  const unstyled =
    options.raw === true
      ? displayValue
      : options.icon
        ? `${options.icon}${displayValue}`
        : label
          ? `${label} ${displayValue}`
          : displayValue;
  const styled =
    renderOptions.preservedTrimStyles && !renderOptions.stripIncomingStyles
      ? `${renderOptions.preservedTrimStyles}${unstyled}`
      : unstyled;

  return applyColors(
    styled,
    renderOptions.fg ?? options.fg,
    renderOptions.bg ?? options.bg,
    renderOptions.bold ?? options.bold,
    ctx.colorLevel,
    ctx.theme,
    ctx.scheme,
  );
}
