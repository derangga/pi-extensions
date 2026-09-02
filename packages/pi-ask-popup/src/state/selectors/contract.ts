import type { PreviewPaneProps } from "../../view/components/preview/preview-pane.js";
import type { StatefulView } from "../../view/stateful-view.js";
import type { TabComponents } from "../../view/tab-components.js";
import type { QuestionData } from "../../tool/types.js";
import type { WrappingSelectItem } from "../row-intent.js";
import type { ActiveView, QuestionnaireState } from "../state.js";

/**
 * Everything a selector may read besides canonical state. Per-tick and
 * read-only: the adapter builds one of these per `apply()` and hands the same
 * object to every binding.
 *
 * `activeView` and `WrappingSelectItem` come from the state layer, not from the
 * view. Which surface owns the keyboard, and what a row means, are canonical
 * facts; the components only render the answer.
 */
export interface BindingContext {
  readonly questions: readonly QuestionData[];
  readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  readonly totalQuestions: number;
  readonly activeView: ActiveView;
  readonly inputBuffer: string;
  /**
   * Caret position in `inputBuffer`, always known: the adapter computes it from
   * the editor every tick. The two row views that consume it disagree on
   * whether their own prop is optional, so pinning it down here is what keeps
   * one selector from having to satisfy both shapes.
   */
  readonly inputCursorOffset: number;
  readonly activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** `BindingContext` plus the tab a per-tab binding is currently visiting. */
export interface PerTabBindingContext extends BindingContext {
  readonly tab: TabComponents;
  readonly i: number;
}

export type GlobalSelector<P> = (state: QuestionnaireState, ctx: BindingContext) => P;
export type PerTabSelector<P> = (state: QuestionnaireState, ctx: PerTabBindingContext) => P;
