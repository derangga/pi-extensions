/**
 * The directory picker `/dir-perm-add` opens when it is given no path: a text
 * field over a list of the directories beside it, filtered as you type.
 *
 * It is assembled from components Pi already ships (`Input`, `SelectList`), so
 * editing keys, keybinding overrides and horizontal scrolling behave exactly
 * as they do in the composer. This file only routes keys between the two and
 * decides what the typed text points at.
 */
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { isDirectory, resolveCandidate } from "./boundary.js";
import {
  getKeybindings,
  Input,
  SelectList,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

const VISIBLE_ENTRIES = 10;
/**
 * Sequences that mean "move to line end", most standard first. `Input` keeps
 * its cursor private and `setValue` leaves the caret where it was, so the only
 * way to park it after prefilled or completed text is the key the user would
 * otherwise press. Checked against the live binding rather than sent blind, so
 * a rebound editor does not get a stray control character typed into it.
 */
const CURSOR_END_KEYS = ["\u001b[F", "\u001bOF", "\u0005"];
/** Where the field starts. The directory you want is almost never inside this one. */
const START_VALUE = `..${sep}`;

/** Subdirectories of `dir`, dotted entries last, unreadable directories empty. */
function listDirectories(dir: string): SelectItem[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  names.sort((left, right) => {
    const dotted = Number(left.startsWith(".")) - Number(right.startsWith("."));
    return dotted !== 0 ? dotted : left.localeCompare(right);
  });
  return names.map((name) => ({ value: name, label: `${name}${sep}`, description: "directory" }));
}

/**
 * Split the typed text where the last separator falls: everything up to it
 * names the directory being listed, the rest filters that listing. Typing
 * `../ms-` lists the parent and filters to entries starting `ms-`.
 */
export function splitPath(value: string): { dirPart: string; prefix: string } {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf(sep));
  return index < 0
    ? { dirPart: "", prefix: value }
    : { dirPart: value.slice(0, index + 1), prefix: value.slice(index + 1) };
}

export function moveCaretToEnd(input: Input): void {
  const keybindings = getKeybindings();
  const key = CURSOR_END_KEYS.find((candidate) =>
    keybindings.matches(candidate, "tui.editor.cursorLineEnd"),
  );
  if (key !== undefined) {
    input.handleInput(key);
  }
}

function listTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("dim", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

class DirectoryPicker implements Component, Focusable {
  focused = false;
  private readonly input = new Input();
  private list: SelectList;
  /** The directory the current listing came from, so a keystroke inside it costs no readdir. */
  private listedDir = "";
  private lastValue = "";
  private error: string | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly cwd: string,
    private readonly done: (result: string | undefined) => void,
  ) {
    this.list = new SelectList([], VISIBLE_ENTRIES, listTheme(theme));
    this.input.setValue(START_VALUE);
    moveCaretToEnd(this.input);
    this.input.onEscape = () => {
      this.done(undefined);
    };
    this.input.onSubmit = (value: string) => {
      this.submit(value);
    };
    this.syncListing();
  }

  private syncListing(): void {
    const value = this.input.getValue();
    if (value === this.lastValue) {
      return;
    }
    this.lastValue = value;
    const { dirPart, prefix } = splitPath(value);
    const dir = resolveCandidate(dirPart === "" ? "." : dirPart, this.cwd);
    if (dir !== this.listedDir) {
      this.listedDir = dir;
      this.list = new SelectList(listDirectories(dir), VISIBLE_ENTRIES, listTheme(this.theme));
    }
    this.list.setFilter(prefix);
  }

  /** Replace the typed name with the highlighted one, ready for the next segment. */
  private complete(): void {
    const selected = this.list.getSelectedItem();
    if (!selected) {
      return;
    }
    const { dirPart } = splitPath(this.input.getValue());
    this.input.setValue(`${dirPart}${selected.value}${sep}`);
    moveCaretToEnd(this.input);
    this.syncListing();
  }

  private submit(value: string): void {
    const target = resolveCandidate(value.trim(), this.cwd);
    if (!isDirectory(target)) {
      this.error = `Not a directory: ${target}`;
      return;
    }
    this.done(target);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (data === "\t") {
      this.complete();
      return;
    }
    if (
      keybindings.matches(data, "tui.select.up") ||
      keybindings.matches(data, "tui.select.down")
    ) {
      this.list.handleInput(data);
      return;
    }
    this.error = undefined;
    this.input.handleInput(data);
    this.syncListing();
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    this.input.focused = this.focused;
    const lines = [
      this.theme.bold(this.theme.fg("accent", "Add directory permission")),
      this.theme.fg("muted", "Pi may read and write files here for the rest of this session."),
      "",
      this.theme.fg("text", "Enter the path to the directory:"),
      ...this.input.render(width),
    ];
    if (this.error !== undefined) {
      lines.push(this.theme.fg("error", this.error));
    }
    lines.push(...this.list.render(width));
    lines.push(this.theme.fg("dim", "Tab to complete · Enter to add · Esc to cancel"));
    return lines;
  }
}

/** Resolves to the chosen directory, or undefined when the user escapes out. */
export function pickDirectory(ui: ExtensionUIContext, cwd: string): Promise<string | undefined> {
  return ui.custom<string | undefined>(
    (_tui, theme, _keybindings, done) => new DirectoryPicker(theme, cwd, done),
  );
}
