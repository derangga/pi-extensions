import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.js";

/**
 * Per-tick projection of TabBar state. The selector
 * (`selectTabBarProps`) hoists every render-time derivation
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) into props so
 * `render()` is pure styling. Replaces the prior `setConfig(TabBarConfig)`
 * snowflake and the inline `+ 1` magic at `props-adapter.ts:127`.
 */
/**
 * Marks a tab that carries a note.
 *
 * It occupies the separator slot between the answered box and the label rather
 * than being appended, so a segment is the same width noted or not. Appending
 * it would add one cell per tab, and four tabs at the schema's 16-character
 * header limit already put this bar at 99 columns: four suffixes would push it
 * to 103, past the 100 columns previews require.
 */
export const NOTED_MARKER = "*";

/** Shown in place of the question tabs that did not fit. */
export const TAB_OVERFLOW_ELLIPSIS = "…";

export interface TabBarProps {
  /** One per author-defined question, in order. */
  tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean; noted: boolean }>;
  /** Submit-tab state. `allAnswered` drives the success/dim color picker. */
  submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements StatefulView<TabBarProps> {
  private props: TabBarProps;

  constructor(private readonly theme: Theme) {
    this.props = { tabs: [], submit: { active: false, allAnswered: false } };
  }

  setProps(props: TabBarProps): void {
    this.props = props;
  }

  handleInput(_data: string): void {}

  invalidate(): void {}

  /**
   * Question tabs absorb the truncation; the Submit pill does not.
   *
   * Four 16-character headers put this bar past 99 columns, so a narrower
   * terminal always drops something. Trimming the joined line from the right
   * dropped Submit first, and a user who cannot see Submit cannot finish the
   * questionnaire. The tail is reserved, the question tabs are trimmed to what
   * is left, and `TAB_OVERFLOW_ELLIPSIS` marks the tabs that went missing.
   *
   * Below the tail's own width there is nothing left to reserve — the whole
   * line is clipped, as before, so the caller's `visibleWidth <= width`
   * invariant survives every terminal size.
   */
  render(width: number): string[] {
    const pieces: string[] = [" ← "];

    for (const tab of this.props.tabs) {
      const box = tab.answered ? "■" : "□";
      const rawSeg = ` ${box}${tab.noted ? NOTED_MARKER : " "}${tab.label} `;
      const styled = tab.active
        ? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
        : this.theme.fg(tab.answered ? "success" : "muted", rawSeg);
      pieces.push(styled);
      pieces.push(" ");
    }

    const submitText = " ✓ Submit ";
    const submitStyled = this.props.submit.active
      ? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
      : this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submitText);
    const tail = `${submitStyled} →`;
    const tailWidth = visibleWidth(tail);
    const head = pieces.join("");

    if (width <= tailWidth) {
      return [truncateToWidth(`${head}${tail}`, width, ""), ""];
    }
    const headLine = truncateToWidth(head, width - tailWidth, TAB_OVERFLOW_ELLIPSIS);
    return [`${headLine}${tail}`, ""];
  }
}
