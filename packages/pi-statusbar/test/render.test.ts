import { describe, expect, it } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { applyColors, stripAnsi } from "../src/colors.js";
import { STATUS_KEY } from "../src/config.js";
import { renderStatusbar, type RenderStatusbarOptions } from "../src/render.js";
import type { StatusbarSettings, WidgetEntry } from "../src/types.js";
import { registry, type WidgetType } from "../src/widgets/registry.js";
import { WidgetStore } from "../src/widgets/store.js";
import { statusbarData, type DataOverrides } from "./helpers/data.js";
import { partialTheme, taggedTheme } from "./helpers/theme.js";

const SETTINGS: StatusbarSettings = {
  version: 1,
  enabled: true,
  preset: "default",
  separator: "pipe",
  separatorFg: "default",
  separatorBg: "default",
  iconMode: "emoji",
};

interface WidgetSpecInput {
  type: WidgetType;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

function storeFor(
  lines: readonly (readonly WidgetSpecInput[])[],
  overrides: Partial<StatusbarSettings> = {},
): WidgetStore {
  const hydrate = ({ type, options = {}, enabled = true }: WidgetSpecInput) => {
    const entry: WidgetEntry = { ...registry.createEntry(type, options), enabled };
    return registry.hydrateWidget(entry);
  };
  return new WidgetStore(
    { ...SETTINGS, ...overrides },
    lines.map((line) => line.map(hydrate)),
  );
}

const PLAIN: RenderStatusbarOptions = { colorLevel: "none" };

function render(
  store: WidgetStore,
  width = 80,
  data: DataOverrides = {},
  options: RenderStatusbarOptions = PLAIN,
): string[] {
  return renderStatusbar(store, statusbarData(data), width, options);
}

describe("renderStatusbar", () => {
  it("draws nothing when the footer is disabled", () => {
    expect(render(storeFor([[{ type: "model" }]], { enabled: false }))).toEqual([]);
  });

  it("draws nothing at zero or negative width", () => {
    const store = storeFor([[{ type: "model" }]]);
    expect(render(store, 0)).toEqual([]);
    expect(render(store, -10)).toEqual([]);
  });

  it("joins segments with the configured separator", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "cwd-basename", options: { raw: true } },
      ],
    ]);
    expect(render(store)).toEqual(["opus | repo"]);
  });

  it("leaves no separator behind a widget that rendered empty", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "git-sha", options: { raw: true, hideWhenEmpty: true } },
        { type: "cwd-basename", options: { raw: true } },
      ],
    ]);
    expect(render(store, 80, { git: { sha: null } })).toEqual(["opus | repo"]);
  });

  it("skips a disabled widget", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "cwd-basename", options: { raw: true }, enabled: false },
      ],
    ]);
    expect(render(store)).toEqual(["opus"]);
  });

  it("drops a line whose widgets all render empty", () => {
    const store = storeFor([
      [
        { type: "git-branch", options: { raw: true, hideWhenEmpty: true } },
        { type: "git-sha", options: { raw: true, hideWhenEmpty: true } },
      ],
      [{ type: "model", options: { raw: true } }],
    ]);
    expect(render(store, 80, { git: { branch: null, sha: null } })).toEqual(["opus"]);
  });

  it("pushes the right side of a flex line to the far edge", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "flex-separator" },
        { type: "cwd-basename", options: { raw: true } },
      ],
    ]);
    const [line] = render(store, 20);
    expect(line).toBe("opus            repo");
    expect(line).toHaveLength(20);
  });

  it("leaves a flex line with an empty right side unpadded", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "flex-separator" },
        { type: "git-sha", options: { raw: true, hideWhenEmpty: true } },
      ],
    ]);
    expect(render(store, 40, { git: { sha: null } })).toEqual(["opus"]);
  });

  it("keeps one space between the sides when a flex line overflows", () => {
    const store = storeFor([
      [
        { type: "model", options: { raw: true } },
        { type: "flex-separator" },
        { type: "cwd-basename", options: { raw: true } },
      ],
    ]);
    // pi-tui wraps its own ellipsis in a reset pair, so compare the visible text.
    expect(render(store, 8).map(stripAnsi)).toEqual(["opus re…"]);
  });
});

describe("renderStatusbar truncation", () => {
  const wide = storeFor([
    [
      { type: "model", options: { raw: true } },
      { type: "cwd-basename", options: { raw: true } },
      { type: "git-branch", options: { raw: true } },
    ],
  ]);

  it("truncates a line to the given width with an ellipsis", () => {
    expect(render(wide, 12).map(stripAnsi)).toEqual(["opus | repo…"]);
  });

  it("never leaves a half-written escape sequence behind", () => {
    // Every widget here carries a color, so a colored line cut mid-segment is
    // the case that would emit an ESC with no terminator and take the rest of
    // the row with it.
    const escape = String.fromCharCode(0x1b);
    for (let width = 1; width <= 40; width += 1) {
      const [line = ""] = renderStatusbar(wide, statusbarData(), width, { colorLevel: "ansi" });
      expect(stripAnsi(line)).not.toContain(escape);
      expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
    }
  });
});

describe("extension status row", () => {
  const store = storeFor([[{ type: "model", options: { raw: true } }]]);

  function withStatuses(entries: readonly (readonly [string, string])[], theme?: Theme): string[] {
    return renderStatusbar(store, statusbarData(), 80, {
      colorLevel: theme ? "ansi" : "none",
      getExtensionStatuses: () => new Map(entries),
      ...(theme ? { theme } : {}),
    });
  }

  it("adds no row when no getter is supplied", () => {
    expect(render(store)).toEqual(["opus"]);
  });

  it("adds no row when nobody published a status", () => {
    expect(withStatuses([])).toEqual(["opus"]);
  });

  it("appends other extensions' statuses sorted by key", () => {
    expect(
      withStatuses([
        ["zebra", "z-status"],
        ["alpha", "a-status"],
      ]),
    ).toEqual(["opus", "a-status z-status"]);
  });

  it("excludes our own status and any empty value", () => {
    expect(
      withStatuses([
        [STATUS_KEY, "pi-statusbar"],
        ["quiet", ""],
        ["loud", "working"],
      ]),
    ).toEqual(["opus", "working"]);
  });

  it("adds no row when only our own status is published", () => {
    expect(withStatuses([[STATUS_KEY, "pi-statusbar"]])).toEqual(["opus"]);
  });

  it("dims the row with the theme's own dim color when it has one", () => {
    const [, row] = withStatuses([["alpha", "a-status"]], taggedTheme);
    expect(row).toBe("<dim>a-status</dim>");
  });

  it("falls back to a fixed dim color when the theme does not define one", () => {
    const [, row] = withStatuses([["alpha", "a-status"]], partialTheme([]));
    expect(row).toBe(applyColors("a-status", "brightBlack", undefined, false, "ansi"));
  });
});
