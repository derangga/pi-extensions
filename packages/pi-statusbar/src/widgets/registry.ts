import type { WidgetEntry, WidgetOptions } from "../types.js";
import { WidgetInstance } from "./instance.js";
import { FlexSeparatorWidget } from "./layout/flex-separator.js";
import { sanitizeOptionsFromSpec } from "./options.js";
import type { Widget } from "./types.js";

const WIDGETS = [FlexSeparatorWidget] as const;

export type WidgetSpecUnion = (typeof WIDGETS)[number];
export type WidgetType = WidgetSpecUnion["type"];

interface WidgetRegistry {
  readonly specs: readonly WidgetSpecUnion[];

  spec(type: WidgetType): WidgetSpecUnion;
  maybeSpec(type: string): WidgetSpecUnion | undefined;
  createEntry(type: WidgetType, options?: Record<string, unknown>): WidgetEntry;
  normalizeOptions(type: WidgetType, input: Record<string, unknown>): WidgetOptions;
  hydrateWidget(entry: WidgetEntry): Widget;
}

function createWidgetRegistry(widgets: readonly WidgetSpecUnion[]): WidgetRegistry {
  const specs = [...widgets];
  const specsByType = new Map<WidgetType, WidgetSpecUnion>(
    specs.map((spec) => [spec.type as WidgetType, spec]),
  );

  const specFor = (type: WidgetType): WidgetSpecUnion => {
    const spec = specsByType.get(type);
    if (!spec) throw new Error(`Unsupported widget type: ${type}`);
    return spec;
  };

  const buildEntry = (
    type: WidgetType,
    options: Record<string, unknown> = {},
    enabled = true,
  ): WidgetEntry => ({
    id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    enabled,
    options: sanitizeOptionsFromSpec(specFor(type), options),
  });

  return {
    specs,
    spec(type) {
      return specFor(type);
    },
    maybeSpec(type) {
      return specsByType.get(type as WidgetType);
    },
    createEntry(type, options = {}) {
      return buildEntry(type, options);
    },
    normalizeOptions(type, input) {
      return sanitizeOptionsFromSpec(specFor(type), input);
    },
    hydrateWidget(entry) {
      return new WidgetInstance(specFor(entry.type), {
        id: entry.id,
        type: entry.type,
        enabled: entry.enabled,
        options: { ...entry.options },
      });
    },
  };
}

export const registry = createWidgetRegistry(WIDGETS);
