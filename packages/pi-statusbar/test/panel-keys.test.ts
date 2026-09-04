import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";

import { stripAnsi } from "../src/colors.js";
import { COMMAND_NAME, PANEL_HINT, registerStatusbarCommand } from "../src/command.js";
import { cloneConfig, DEFAULT_CONFIG } from "../src/config.js";
import {
  buildPanelItems,
  ROW_DISMISS,
  ROW_ENABLED,
  ROW_ICONS,
  ROW_PRESET,
  ROW_SEPARATOR,
} from "../src/panel.js";
import { PRESET_DEFINITIONS } from "../src/presets.js";
import { SEPARATOR_VALUES } from "../src/separators.js";
import type { StatusbarConfig } from "../src/types.js";
import { stubApi, stubContext } from "./helpers/pi.js";

/**
 * Drives the real SettingsList with real keystrokes. The panel keeps its own
 * cursor because the list's is private, and the two drifting apart is the
 * failure that matters: the arrows would change a row other than the one under
 * the cursor. Nothing about that is visible from the pure helpers, so it is
 * tested through the component pi actually builds.
 */

const ESC = String.fromCodePoint(0x1b);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const ENTER = "\r";
const RIGHT = `${ESC}[C`;

beforeAll(() => {
  // Both of these are process-wide state that only a running TUI installs, and
  // the panel is only ever built where ctx.hasUI is true. getSettingsListTheme
  // throws outright without the first.
  initTheme();
  // SettingsList reads the process-wide keybindings, which only the running TUI
  // installs. Without this its up and down do nothing and every test below
  // would pass for the wrong reason.
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

async function openPanel(initial: StatusbarConfig = cloneConfig(DEFAULT_CONFIG)) {
  let config = initial;
  const commits: StatusbarConfig[] = [];
  const api = stubApi();
  const context = stubContext();

  registerStatusbarCommand(api.pi, {
    current: () => config,
    commit: async (next: StatusbarConfig, _ctx: ExtensionCommandContext) => {
      config = next;
      commits.push(next);
    },
  });

  await api.run(COMMAND_NAME, "", context.ctx);
  const panel = context.panel();
  if (!panel) throw new Error("the command opened no panel");

  const rowIds = buildPanelItems(initial).map((item) => item.id);
  // Mirrors where the panel's own cursor should be, so goTo can walk a
  // relative distance. The panel keeps that index private, which is the same
  // reason the panel itself has to keep one.
  let at = 0;

  const flush = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  return {
    context,
    commits,
    latest: () => config,
    /** Walks the cursor to a row by id, so a new row does not shift the count. */
    goTo: async (id: string) => {
      const target = rowIds.indexOf(id);
      if (target === -1) throw new Error(`no row ${id}`);
      for (let step = 0; step < (target - at + rowIds.length) % rowIds.length; step += 1) {
        panel.handleInput?.(DOWN);
      }
      at = target;
      await flush();
    },
    // Awaits a turn of the event loop. The component applies a change with a
    // floating promise, since handleInput cannot be async, so a synchronous
    // assertion right after a keypress sees whatever happened before the first
    // suspension and nothing after it. Without this flush a test asserting on
    // notifications passes no matter what the code does.
    /** Several keys inside one tick, with no chance for a resync between them. */
    burst: async (...keys: string[]) => {
      for (const key of keys) panel.handleInput?.(key);
      await flush();
    },
    press: async (keys: string) => {
      panel.handleInput?.(keys);
      if (keys === DOWN) at = (at + 1) % rowIds.length;
      else if (keys === UP) at = (at - 1 + rowIds.length) % rowIds.length;
      await flush();
    },
    lines: () => panel.render(80),
  };
}

describe("the /statusbar panel", () => {
  it("opens with a row per setting and the current value on it", async () => {
    const panel = await openPanel();
    const text = panel.lines().join("\n");

    expect(text).toContain("Layout preset");
    expect(text).toContain("Icon set");
    expect(text).toContain("Footer");
    expect(text).toContain("default");
  });

  it("changes the first row under the right arrow", async () => {
    const panel = await openPanel();
    await panel.press(RIGHT);

    expect(panel.latest().preset).toBe("compact");
    expect(panel.lines().join("\n")).toContain("compact");
  });

  it("walks back under the left arrow, wrapping past the first value", async () => {
    const panel = await openPanel();
    await panel.press(LEFT);

    expect(panel.latest().preset).toBe("git-heavy");
  });

  it("changes the row the cursor is on, not the row it started on", async () => {
    // The whole reason the panel tracks its own cursor. If it drifts from the
    // list's, the arrows edit the wrong setting while the highlight says
    // otherwise.
    const panel = await openPanel();
    await panel.goTo(ROW_ICONS);
    await panel.press(RIGHT);

    expect(panel.latest().iconMode).toBe("nerd");
    expect(panel.latest().preset).toBe("default");
  });

  it("follows the cursor back up again", async () => {
    const panel = await openPanel();
    await panel.goTo(ROW_ENABLED);
    await panel.press(UP);
    await panel.press(RIGHT);

    expect(panel.latest().iconMode).toBe("nerd");
    expect(panel.latest().enabled).toBe(true);
  });

  it("reaches the last row and toggles the footer there", async () => {
    const panel = await openPanel();
    await panel.goTo(ROW_ENABLED);
    await panel.press(RIGHT);

    expect(panel.latest().enabled).toBe(false);
  });

  it("applies every change as it happens rather than on close", async () => {
    // Escape is not a cancel here: the footer has already redrawn behind the
    // panel, so there is nothing left to confirm.
    const panel = await openPanel();
    await panel.press(RIGHT);
    await panel.press(RIGHT);

    expect(panel.commits).toHaveLength(2);
    expect(panel.latest().preset).toBe("git-heavy");
  });

  it("says nothing while the panel is open", async () => {
    // One notification per arrow press would bury the panel that caused it.
    const panel = await openPanel();
    await panel.press(RIGHT);
    await panel.press(DOWN);
    await panel.press(RIGHT);

    expect(panel.context.notifications).toEqual([]);
  });

  it("closes on Dismiss and keeps every change already applied", async () => {
    const panel = await openPanel();
    await panel.press(RIGHT);
    await panel.goTo(ROW_ICONS);
    await panel.press(RIGHT);

    await panel.goTo(ROW_DISMISS);
    await panel.press(ENTER);

    expect(panel.context.closed()).toBe(true);
    expect(panel.latest().preset).toBe("compact");
    expect(panel.latest().iconMode).toBe("nerd");
  });

  it("keeps them on escape too, so both ways out mean the same thing", async () => {
    // Closing saves nothing and undoes nothing: the change landed when the
    // arrow moved. Two exits that differed would be the only place in the
    // panel where the order of keys mattered.
    const panel = await openPanel();
    await panel.press(RIGHT);
    await panel.press(ESC);

    expect(panel.context.closed()).toBe(true);
    expect(panel.latest().preset).toBe("compact");
  });

  it("commits nothing of its own when closing", async () => {
    // Dismiss must not write. A commit here would be a second write of a
    // config already on disk, and the shape of an undo that is not one.
    const panel = await openPanel();
    await panel.press(RIGHT);
    const before = panel.commits.length;

    await panel.goTo(ROW_DISMISS);
    await panel.press(ENTER);

    expect(panel.commits).toHaveLength(before);
  });

  it("cycles the separator, which is why compact looked like it had none", async () => {
    const panel = await openPanel();
    await panel.goTo(ROW_SEPARATOR);
    await panel.press(RIGHT);

    expect(panel.latest().separator).toBe("pipe");
    expect(panel.lines().join("\n")).toContain("pipe");
  });

  it("redraws the separator row when a preset rewrites it underneath", async () => {
    // A preset carries its own separator, so moving the preset row changes a
    // value another row is showing. Without a resync that row keeps drawing
    // the old style, and the next arrow press there cycles from a value the
    // config no longer holds.
    const panel = await openPanel();
    await panel.goTo(ROW_SEPARATOR);
    await panel.press(RIGHT);
    expect(panel.latest().separator).toBe("pipe");

    await panel.goTo(ROW_PRESET);
    await panel.press(RIGHT);

    const applied = PRESET_DEFINITIONS.compact.separator;
    expect(panel.latest().preset).toBe("compact");
    expect(panel.latest().separator).toBe(applied);

    const row = panel
      .lines()
      .map((line) => stripAnsi(line))
      .find((line) => line.includes("Separator"));
    expect(row).toContain(applied);
    expect(row).not.toContain("pipe");
  });

  it("keeps arrowing from the value the config holds after a resync", async () => {
    // The row's own currentValue is what cycleValue steps from, so a stale one
    // would send the next press somewhere unrelated.
    const panel = await openPanel();
    await panel.goTo(ROW_SEPARATOR);
    await panel.press(RIGHT);
    await panel.goTo(ROW_PRESET);
    await panel.press(RIGHT);
    await panel.goTo(ROW_SEPARATOR);
    await panel.press(RIGHT);

    const from = SEPARATOR_VALUES.indexOf(PRESET_DEFINITIONS.compact.separator);
    expect(panel.latest().separator).toBe(SEPARATOR_VALUES[from + 1]);
  });

  it("steps twice for two presses inside one tick", async () => {
    // Each press has to leave the row holding its new value straight away.
    // The row is what the next press cycles from, and the resync that would
    // otherwise correct it only lands a tick later, so both presses would
    // step from the same value and the second would be a no-op.
    const panel = await openPanel();
    await panel.burst(RIGHT, RIGHT);

    expect(panel.latest().preset).toBe("git-heavy");
  });

  it("leaves the closing row alone under the arrows", async () => {
    // It holds no value to cycle, so an arrow there must not wrap into some
    // other row's setting.
    const panel = await openPanel();
    await panel.goTo(ROW_DISMISS);
    await panel.press(RIGHT);
    await panel.press(LEFT);

    expect(panel.commits).toHaveLength(0);
    expect(panel.context.closed()).toBe(false);
  });

  it("puts the reset line directly under the list's hint, with no gap", async () => {
    // The two read as one block. A blank line between them makes the second
    // look like a stray line of output rather than part of the same footnote.
    const panel = await openPanel();
    const lines = panel.lines().map((line) => stripAnsi(line).trimEnd());
    const hint = lines.findIndex((line) => line.includes("Enter/Space to change"));

    expect(hint).toBeGreaterThan(-1);
    expect(lines[hint + 1]).toBe(`  ${PANEL_HINT}`);
  });

  it("says nothing about the arrows, which would rival Enter for the same job", async () => {
    // The rightward arrow is SettingsList's cursor glyph, so only the hint
    // block can be checked for arrows, not the whole panel.
    const panel = await openPanel();
    const lines = panel.lines().map((line) => stripAnsi(line));
    const hint = lines.findIndex((line) => line.includes("Enter/Space to change"));

    expect(PANEL_HINT).not.toMatch(/[\u2190\u2192]/);
    for (const line of lines.slice(hint)) expect(line).not.toMatch(/[\u2190\u2192]/);
  });
});
