import {
  fuzzyFilter,
  Input,
  SelectList,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Filters model choices by fuzzy match against label + description.
 * Empty query returns the full list; a query that matches nothing returns [].
 */
export function filterModels(choices: readonly SelectItem[], query: string): SelectItem[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [...choices];
  }
  return fuzzyFilter([...choices], trimmed, (item) => `${item.label} ${item.description ?? ""}`);
}

function wrapTheme(theme: SelectListTheme): SelectListTheme {
  return {
    ...theme,
    noMatch: (text: string) =>
      theme.noMatch(text.replace("No matching commands", "No matching models")),
  };
}

/**
 * A searchable wrapper around SelectList. Stacks an Input on top of a list,
 * filters with fuzzyFilter, and handles Esc to clear vs dismiss.
 *
 * Its own component rather than patching SelectList.setFilter, which is
 * prefix-only and would need a fork to become fuzzy.
 */
export class FilterableSelectList {
  private readonly allItems: readonly SelectItem[];
  private filtered: SelectItem[];
  private readonly input: Input;
  private list: SelectList;
  private readonly theme: SelectListTheme;
  private readonly maxVisible: number;
  private query = "";

  onSelect: ((item: SelectItem) => void) | undefined = undefined;
  onCancel: (() => void) | undefined = undefined;
  onSelectionChange: ((item: SelectItem) => void) | undefined = undefined;

  constructor(items: readonly SelectItem[], maxVisible: number, theme: SelectListTheme) {
    this.allItems = items;
    this.filtered = [...items];
    this.maxVisible = maxVisible;
    this.theme = wrapTheme(theme);
    this.input = new Input();
    this.list = this.createList(this.filtered);
  }

  setSelectedIndex(index: number): void {
    this.list.setSelectedIndex(index);
  }

  getSelectedItem(): SelectItem | null {
    return this.list.getSelectedItem();
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(...this.input.render(width));
    if (this.filtered.length === 0) {
      lines.push(this.theme.noMatch("  No matching models"));
    } else {
      lines.push(...this.list.render(width));
    }
    const hint =
      this.query.length > 0
        ? "  Type to filter \u00b7 Esc to clear \u00b7 Enter to pick"
        : "  Type to filter \u00b7 \u2191\u2193 move \u00b7 Enter pick \u00b7 Esc dismiss";
    lines.push(truncateToWidth(this.theme.scrollInfo(hint), width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.cancel")) {
      if (this.query.length > 0) {
        this.input.setValue("");
        this.query = "";
        this.applyFilter("");
      } else if (this.onCancel) {
        this.onCancel();
      }
      return;
    }

    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.list.handleInput(data);
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      if (this.filtered.length === 0) {
        return;
      }
      this.list.handleInput(data);
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) {
      this.query = after;
      this.applyFilter(after);
    }
  }

  private applyFilter(query: string): void {
    this.filtered = filterModels(this.allItems, query);
    const previousSelect = this.onSelect;
    const previousCancel = this.onCancel;
    const previousChange = this.onSelectionChange;
    this.list = this.createList(this.filtered);
    this.onSelect = previousSelect;
    this.onCancel = previousCancel;
    this.onSelectionChange = previousChange;
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, this.theme);
    list.onSelect = (item) => this.onSelect?.(item);
    list.onCancel = () => this.onCancel?.();
    list.onSelectionChange = (item) => this.onSelectionChange?.(item);
    return list;
  }
}
