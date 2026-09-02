import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer } from "@earendil-works/pi-tui";
import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay } from "../config.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import {
  QuestionTabStrategy,
  SubmitTabStrategy,
  type TabContentStrategy,
} from "./tab-content-strategy.js";

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_NEW_LINE = "Shift+Enter for newline";
export const HINT_PART_CLEAR = "Ctrl+U to clear";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";

/**
 * The collapse hint is templated because the shortcut is configurable. Call
 * sites `.replace()` the placeholder with `formatKeySpecForDisplay` of the
 * resolved key, so the hint always names the key that is actually bound.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/** The collapse template rendered with the default key, for hint assertions. */
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(
  KEY_PLACEHOLDER,
  formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY),
);

/**
 * The resting hint core for single-select question tabs. Resting means: notes
 * closed and no custom-answer row capturing text. `buildHintText` drops NOTES
 * in either of those states, and on a multiSelect tab it wedges TOGGLE between
 * NAV and NOTES, so neither composite is a substring there — assert on the
 * `HINT_PART_*` pieces in those cases instead.
 *
 * The collapse affordance is appended after cancel so the core stays a
 * contiguous prefix of the rendered line. Narrow terminals clip the tail with
 * `…` and keep the core.
 */
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_CANCEL].join(
  " · ",
);
export const HINT_MULTI = [
  HINT_PART_ENTER,
  HINT_PART_NAV,
  HINT_PART_NOTES,
  HINT_PART_TAB,
  HINT_PART_CANCEL,
].join(" · ");

/**
 * The whole footer while `state.collapsed` is true. The session renders this
 * directly, bypassing `buildHintText`, and substitutes the configured key.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");

export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

/** Everything fits: pad after the footer so every tab occupies the same height. */
function renderFitsTerminal(natural: string[], spacerRows: number): string[] {
  return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
}

/** No room for any middle content — show the chrome alone, hard-clamped to the terminal. */
function renderChromeOnly(
  natural: string[],
  topFixed: number,
  bottomFixed: number,
  termRows: number,
): string[] {
  const chromeOnly = [
    ...natural.slice(0, topFixed),
    ...natural.slice(natural.length - bottomFixed),
  ];
  return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
}

/**
 * Where the scroll window starts: centered on the focused option, clamped to
 * the ends. Top-anchored when nothing is focused, which is the submit tab.
 */
function computeScrollStart(
  bodyRange: [number, number] | undefined,
  headingCount: number,
  availableMiddle: number,
  middleRows: number,
): number {
  if (!bodyRange) return 0;
  const focusedRowInMiddle = headingCount + bodyRange[0];
  const focusedHeight = bodyRange[1] - bodyRange[0];
  const idealStart =
    focusedRowInMiddle - Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
  return Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
}

/**
 * Mark the scroll window's edges. A one-row middle overflowing both ways gets
 * the combined ↕: writing ↑ then ↓ to the same row would leave only the ↓ and
 * hide the fact that there is anything above.
 */
function decorateOverflow(
  scrollableMiddle: string[],
  hasUp: boolean,
  hasDown: boolean,
  theme: Theme,
): void {
  if (scrollableMiddle.length === 0) return;
  if (hasUp && hasDown && scrollableMiddle.length === 1) {
    scrollableMiddle[0] = theme.fg("dim", OVERFLOW_BOTH);
    return;
  }
  if (hasUp) scrollableMiddle[0] = theme.fg("dim", OVERFLOW_UP);
  if (hasDown) scrollableMiddle[scrollableMiddle.length - 1] = theme.fg("dim", OVERFLOW_DOWN);
}

export type DialogState = QuestionnaireState;

/** Per-tick projection of dialog state. Written by the adapter, read in `render`. */
export interface DialogProps {
  state: DialogState;
  activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** Construction-time config. Frozen once the dialog exists. */
export interface DialogConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  tabBar: TabBar | undefined;
  notesInput: Editor;
  isMulti: boolean;
  tabsByIndex: ReadonlyArray<TabComponents>;
  /** Optional so single-question mode and focused tests can omit it; the submit strategy pads instead. */
  submitPicker?: Component;
  /** Worst-case body height across every tab and option. Sets the stable overall footprint. */
  getBodyHeight: (width: number) => number;
  /** Body height of the tab showing right now. The difference is absorbed outside the border. */
  getCurrentBodyHeight: (width: number) => number;
  /** Terminal height, read at render time — the mirror of the width getter. */
  getTerminalRows: () => number;
  /**
   * Resolved collapse key (`"ctrl+]"`, `"alt+o"`, `"off"`). Construction-time
   * config, deliberately not canonical state: the runtime's copy must never
   * reach a `setProps` consumer. The footer interpolates it, and omits the
   * collapse hint entirely when it is `"off"`.
   */
  collapseKey: string;
}

/**
 * The dialog frame. Owns the three-region layout and nothing else: a sticky
 * heading, a scrolling middle and a sticky footer, assembled from whichever
 * strategy the current tab selects.
 *
 * It is a `StatefulView` like every other renderable rather than a special
 * case. `setProps` writes the cell that `render` reads, and
 * `liveProps.activePreviewPane` is resolved by the adapter each tick — the
 * dialog never derives it, and never reaches into a sibling component.
 */
export class DialogView implements StatefulView<DialogProps> {
  private liveProps: DialogProps;
  private readonly config: DialogConfig;
  private readonly questionStrategy: TabContentStrategy;
  private readonly submitStrategy: TabContentStrategy | undefined;
  private readonly maxFooterRowCount: number;

  constructor(config: DialogConfig, initialProps: DialogProps) {
    this.config = config;
    this.liveProps = initialProps;
    this.questionStrategy = new QuestionTabStrategy({
      theme: config.theme,
      questions: config.questions,
      getPreviewPane: () => this.liveProps.activePreviewPane,
      tabsByIndex: config.tabsByIndex,
      notesInput: config.notesInput,
      isMulti: config.isMulti,
      getCurrentBodyHeight: config.getCurrentBodyHeight,
      collapseKey: config.collapseKey,
    });
    this.submitStrategy = config.isMulti
      ? new SubmitTabStrategy({
          theme: config.theme,
          questions: config.questions,
          submitPicker: config.submitPicker,
          notesInput: config.notesInput,
        })
      : undefined;
    this.maxFooterRowCount = Math.max(
      this.questionStrategy.footerRowCount,
      this.submitStrategy?.footerRowCount ?? 0,
    );
  }

  setProps(props: DialogProps): void {
    this.liveProps = props;
  }

  handleInput(_data: string): void {}

  // No cached layout of its own. Refreshing is the adapter's job, which owns
  // the full set of renderables.
  invalidate(): void {}

  render(width: number): string[] {
    const state = this.liveProps.state;
    const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
    const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;

    // Built once and reused: constructing heading rows twice would build two
    // sets of components for one frame.
    const headingRowCache = strategy.headingRows(state);
    const headingCount = headingRowCache.length;

    // Without the residual spacer — whether it applies depends on overflow.
    const natural = this.buildContainerFromStrategy(strategy, headingRowCache).render(width);

    // Fixed regions, derived from structure rather than measured. `TabBar.render`
    // always returns [tabLine, ""], so it is 2 rows whenever it is present.
    const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
    const bottomFixed = 1 + strategy.footerRowCount;
    const middleRows = natural.length - topFixed - bottomFixed;

    // Keeps every tab the same total height, so switching tabs does not make
    // the dialog jump. Only meaningful when nothing is being scrolled away.
    const spacerRows = Math.max(
      0,
      this.config.getBodyHeight(width) +
        this.maxFooterRowCount -
        strategy.bodyHeight(width, state) -
        strategy.footerRowCount,
    );

    const termRows = this.config.getTerminalRows();

    if (natural.length + spacerRows <= termRows) {
      return renderFitsTerminal(natural, spacerRows);
    }

    const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
    if (availableMiddle === 0) {
      return renderChromeOnly(natural, topFixed, bottomFixed, termRows);
    }

    const scrollStart = computeScrollStart(
      strategy.focusedItemRowRange(width, state),
      headingCount,
      availableMiddle,
      middleRows,
    );
    const scrollableMiddle = natural.slice(
      topFixed + scrollStart,
      topFixed + scrollStart + availableMiddle,
    );
    decorateOverflow(
      scrollableMiddle,
      scrollStart > 0,
      scrollStart + availableMiddle < middleRows,
      this.config.theme,
    );

    // Exactly `termRows` rows: reaching here means `availableMiddle` was
    // positive, so it is `termRows - topFixed - bottomFixed`, and the three
    // slices add back up. The chrome-alone-too-tall case returned above, which
    // is why there is no second clamp here.
    return [
      ...natural.slice(0, topFixed),
      ...scrollableMiddle,
      ...natural.slice(natural.length - bottomFixed),
    ];
  }

  private buildContainerFromStrategy(
    strategy: TabContentStrategy,
    headingRowCache: Component[],
  ): Container {
    const { theme, isMulti, tabBar } = this.config;
    const state = this.liveProps.state;
    const container = new Container();
    const border = () => new DynamicBorder((s) => theme.fg("accent", s));

    container.addChild(border());
    if (isMulti && tabBar) container.addChild(tabBar);
    container.addChild(new Spacer(1));

    for (const c of headingRowCache) container.addChild(c);
    container.addChild(strategy.bodyComponent(state));
    container.addChild(new Spacer(1));
    for (const c of strategy.midRows(state)) container.addChild(c);

    container.addChild(border());
    for (const c of strategy.footerRows(state)) container.addChild(c);

    // The residual spacer lives in render(), not here: whether it applies
    // depends on overflow, which the container cannot see.
    return container;
  }
}
