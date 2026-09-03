import type { StatusbarData } from "../types.js";
import type { BaseWidgetContext, WidgetContext, WidgetDependency } from "./types.js";

/**
 * Hands a widget the render context plus only the data keys its spec declares.
 * A widget that reads something it did not declare gets undefined, which surfaces
 * the missing declaration instead of silently coupling the widget to a full
 * snapshot.
 */
export function contextForDependencies<const TDeps extends readonly WidgetDependency[]>(
  baseCtx: BaseWidgetContext,
  dependencies: TDeps,
  data: StatusbarData,
): WidgetContext<TDeps> {
  const output: BaseWidgetContext & Partial<StatusbarData> = { ...baseCtx };
  const writableOutput = output as BaseWidgetContext & Partial<Record<WidgetDependency, unknown>>;
  for (const dependency of dependencies) {
    writableOutput[dependency] = data[dependency];
  }
  // TODO(widget-spec): remove this cast if TypeScript gains better support for
  // dynamic object construction.
  return output as WidgetContext<TDeps>;
}
