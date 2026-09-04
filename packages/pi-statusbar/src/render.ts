import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { applyColors, hasThemeColor, type ColorLevel } from "./colors.js";
import { extensionStatusValues, type GetExtensionStatuses } from "./extension-statuses.js";
import { activeScheme, type ColorScheme } from "./schemes.js";
import { separatorText } from "./separators.js";
import type { StatusbarData, StatusbarSettings } from "./types.js";
import { contextForDependencies } from "./widgets/context.js";
import { registry } from "./widgets/registry.js";
import type { WidgetStore } from "./widgets/store.js";
import type { BaseWidgetContext, Widget } from "./widgets/types.js";

const ELLIPSIS = "…";

export interface RenderStatusbarOptions {
  /** Resolved once by the caller rather than read from the environment per draw. */
  colorLevel: ColorLevel;
  theme?: Theme;
  getExtensionStatuses?: GetExtensionStatuses;
}

/**
 * One draw of the footer. Every line goes through truncateToWidth, which is
 * ANSI-aware, so a line cut short never leaves half an escape sequence behind
 * for the terminal to swallow the rest of the row with.
 *
 * pi-footer also carries a width mode that renders 40 columns narrower than the
 * terminal. That existed so the config TUI could preview a footer beside its
 * own chrome, and went with the TUI.
 */
export function renderStatusbar(
  store: WidgetStore,
  data: StatusbarData,
  width: number,
  options: RenderStatusbarOptions,
): string[] {
  const settings = store.settings;
  if (!settings.enabled || width <= 0) return [];

  const scheme = activeScheme(settings.colorScheme);
  const baseCtx: BaseWidgetContext = {
    iconMode: settings.iconMode,
    colorLevel: options.colorLevel,
    ...(options.theme ? { theme: options.theme } : {}),
    ...(scheme ? { scheme } : {}),
  };

  const lines = store.lines
    .map((line) => renderLine(line, settings, width, baseCtx, data))
    .filter((line) => line.trim().length > 0);

  const statusLine = extensionStatusLine(width, options, scheme);
  return statusLine === undefined ? lines : [...lines, statusLine];
}

function renderLine(
  line: readonly Widget[],
  settings: StatusbarSettings,
  width: number,
  baseCtx: BaseWidgetContext,
  data: StatusbarData,
): string {
  const rendered = line
    .filter((widget) => widget.enabled)
    .map((widget) => ({
      type: widget.type,
      segment:
        widget.render(
          contextForDependencies(baseCtx, registry.spec(widget.type).dependencies, data),
        ) ?? "",
    }));

  const join = (entries: readonly RenderedSegment[]): string =>
    joinSegments(entries, settings, baseCtx);

  // A flex separator renders nothing itself; it marks where the line splits.
  const flexIndex = rendered.findIndex((entry) => entry.type === "flex-separator");
  if (flexIndex === -1) return truncateToWidth(join(rendered), width, ELLIPSIS);

  const left = join(rendered.slice(0, flexIndex));
  const right = join(rendered.slice(flexIndex + 1));
  // Nothing on the right means nothing to push away from, so the line is
  // ordinary and must not be padded out to the full width.
  return right ? padRight(left, right, width) : truncateToWidth(left, width, ELLIPSIS);
}

interface RenderedSegment {
  type: Widget["type"];
  segment: string;
}

/**
 * Widgets that rendered empty leave no separator behind. pi-footer additionally
 * suppresses the separator next to a `separator` widget; that widget type built
 * the powerline presets and is not in this registry, which leaves the check
 * unreachable.
 */
function joinSegments(
  entries: readonly RenderedSegment[],
  settings: StatusbarSettings,
  ctx: BaseWidgetContext,
): string {
  const segments = entries.map((entry) => entry.segment).filter((segment) => segment.length > 0);
  if (segments.length === 0) return "";

  const separator = applyColors(
    separatorText(settings.separator),
    settings.separatorFg,
    settings.separatorBg,
    false,
    ctx.colorLevel,
    ctx.theme,
    ctx.scheme,
  );
  return segments.join(separator);
}

function padRight(left: string, right: string, width: number): string {
  const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(spaces)}${right}`, width, ELLIPSIS);
}

/**
 * Other extensions' statuses, dimmed, below the footer. Undefined when nobody
 * published one, so an empty row never costs a terminal line.
 */
function extensionStatusLine(
  width: number,
  options: RenderStatusbarOptions,
  scheme: ColorScheme | undefined,
): string | undefined {
  const statuses = options.getExtensionStatuses?.();
  if (!statuses) return undefined;

  const values = extensionStatusValues(statuses);
  if (values.length === 0) return undefined;

  const dim = hasThemeColor(options.theme, "dim") ? "pi:dim" : "brightBlack";
  const painted = applyColors(
    values.join(" "),
    dim,
    undefined,
    false,
    options.colorLevel,
    options.theme,
    scheme,
  );
  return truncateToWidth(painted, width, ELLIPSIS);
}
