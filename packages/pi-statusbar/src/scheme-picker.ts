/**
 * The submenu behind the Color scheme row: thirteen entries, each drawn in its
 * own palette.
 *
 * Its own component rather than pi-tui's SelectList, which wraps the whole
 * selected row in one theme colour. That would strip the palette off the exact
 * row someone is looking at, and comparing palettes is the only reason to draw
 * them at all.
 */

import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { applyColors, type ColorLevel, type HexColor } from "./colors.js";
import {
  COLOR_SCHEMES,
  DEFAULT_SCHEME,
  SCHEME_NAMES,
  type ColorScheme,
  type ColorSchemeName,
} from "./schemes.js";

/**
 * Marks the scheme the picker opened with, which is also the one escape goes
 * back to. A plain check, fixed regardless of the configured icon set: the
 * picker is panel chrome and not footer content, so it must not depend on the
 * patched font the footer's nerd mode assumes.
 */
export const ACTIVE_MARK = "✓";

/** Cursor prefix, matching what pi-tui's own lists draw. */
const CURSOR = "→ ";
const NO_CURSOR = "  ";

/** One cell of the palette preview. Full block, present in every terminal font. */
export const SWATCH_CELL = "█";

/**
 * The slots the swatch shows, in the order a terminal palette is usually
 * printed. Six of the sixteen: enough to tell two schemes apart at a glance,
 * few enough to leave the row room for a name.
 */
const SWATCH_SLOTS = ["red", "yellow", "green", "cyan", "blue", "magenta"] as const;

/**
 * The slot each entry's name is painted in.
 *
 * Not white or black, which is the obvious answer and unreadable half the time:
 * github-light publishes #6e7781 for white and ayu-light #c5c5c8 for
 * brightWhite, both of which vanish against the background those schemes are
 * drawn for. Every one of the twelve keeps blue mid-tone and saturated whichever
 * background it targets, so it is the slot that survives both.
 */
const NAME_SLOT = "blue";

/** What "default" says instead of a swatch, since it has no palette of its own. */
const DEFAULT_NOTE = "(follow Pi's theme)";

/** Announced rather than left to surprise someone on a dark terminal. */
export const LIGHT_NOTE = "light";

/** Rows drawn at once. The rest scroll, so thirteen never overflow a short terminal. */
export const VISIBLE_ROWS = 10;

export interface SchemeEntry {
  name: ColorSchemeName;
  /** Absent for "default", which is the whole of what makes it inherit. */
  scheme?: ColorScheme;
}

/** "default" first, so the way back out is never scrolled off the top. */
export function schemeEntries(): SchemeEntry[] {
  return [
    { name: DEFAULT_SCHEME },
    ...SCHEME_NAMES.map((name) => ({ name, scheme: COLOR_SCHEMES[name] })),
  ];
}

export interface SchemePickerHandlers {
  /** Every cursor move, so the real footer redraws behind the picker. */
  onMove(name: ColorSchemeName): void;
  onPick(name: ColorSchemeName): void;
  onCancel(): void;
}

export class SchemePicker implements Component {
  private readonly entries = schemeEntries();
  private cursor: number;

  constructor(
    /** Fixed for the picker's lifetime: browsing previews, it does not commit. */
    private readonly active: ColorSchemeName,
    private readonly colorLevel: ColorLevel,
    private readonly handlers: SchemePickerHandlers,
  ) {
    const at = this.entries.findIndex((entry) => entry.name === active);
    this.cursor = at === -1 ? 0 : at;
  }

  // Nothing cached, so nothing to drop. Required by Component.
  invalidate(): void {}

  render(width: number): string[] {
    const nameWidth = Math.max(...this.entries.map((entry) => entry.name.length));
    const start = Math.max(
      0,
      Math.min(this.cursor - Math.floor(VISIBLE_ROWS / 2), this.entries.length - VISIBLE_ROWS),
    );
    const end = Math.min(start + VISIBLE_ROWS, this.entries.length);

    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      const entry = this.entries[index];
      if (entry) lines.push(this.renderRow(entry, index === this.cursor, nameWidth, width));
    }
    // Only when something is off screen, so a tall terminal shows no counter.
    if (start > 0 || end < this.entries.length) {
      lines.push(`  (${this.cursor + 1}/${this.entries.length})`);
    }
    return lines;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (keys.matches(data, "tui.select.confirm")) this.handlers.onPick(this.selected());
    else if (keys.matches(data, "tui.select.cancel")) this.handlers.onCancel();
  }

  /** Where the cursor is, so a test can read it without parsing a rendered row. */
  selected(): ColorSchemeName {
    return this.entries[this.cursor]?.name ?? DEFAULT_SCHEME;
  }

  private move(step: number): void {
    this.cursor = (this.cursor + step + this.entries.length) % this.entries.length;
    this.handlers.onMove(this.selected());
  }

  /**
   * The check marks which scheme is live, the arrow marks which one the cursor
   * is on. Two different questions, and browsing moves only the second.
   */
  private renderRow(
    entry: SchemeEntry,
    isCursor: boolean,
    nameWidth: number,
    width: number,
  ): string {
    const mark = entry.name === this.active ? ACTIVE_MARK : " ";
    const name = entry.name.padEnd(nameWidth);
    const painted = entry.scheme ? this.paint(name, entry.scheme.ansi[NAME_SLOT]) : name;
    const tail = entry.scheme
      ? `${this.swatch(entry.scheme)}${entry.scheme.light ? `  ${LIGHT_NOTE}` : ""}`
      : DEFAULT_NOTE;
    return truncateToWidth(
      `${isCursor ? CURSOR : NO_CURSOR}${mark} ${painted}  ${tail}`,
      width,
      "",
    );
  }

  private swatch(scheme: ColorScheme): string {
    return SWATCH_SLOTS.map((slot) => this.paint(SWATCH_CELL, scheme.ansi[slot])).join("");
  }

  private paint(text: string, hex: HexColor): string {
    return applyColors(text, hex, undefined, false, this.colorLevel);
  }
}
