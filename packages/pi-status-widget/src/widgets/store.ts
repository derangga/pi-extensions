import { cloneSettings } from "../config.js";
import type { StatusbarConfig, StatusbarSettings } from "../types.js";
import { registry } from "./registry.js";
import type { Widget } from "./types.js";

/**
 * The live footer state: settings plus hydrated widgets. Config entries are
 * plain data on disk; a widget is that entry bound to its spec, which is what
 * the renderer needs. Rebuilt whenever the config changes rather than mutated.
 */
export class WidgetStore {
  constructor(
    public settings: StatusbarSettings,
    public lines: Widget[][],
  ) {}

  static fromConfig(config: StatusbarConfig): WidgetStore {
    const { lines, ...settings } = config;
    return new WidgetStore(
      cloneSettings(settings),
      lines.map((line) => line.map((entry) => registry.hydrateWidget(entry))),
    );
  }

  toConfig(): StatusbarConfig {
    return {
      ...cloneSettings(this.settings),
      lines: this.lines.map((line) => line.map((widget) => widget.toEntry())),
    };
  }
}
