import type { Editor } from "@earendil-works/pi-tui";
import type { BindingContext, PerTabBindingContext } from "../state/selectors/contract.js";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.js";
import { selectActiveView } from "../state/selectors/focus.js";
import type { WrappingSelectItem } from "../state/row-intent.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { BoundGlobalBinding, BoundPerTabBinding } from "./component-binding.js";
import type { TabComponents } from "./tab-components.js";

/** What the adapter needs of a renderable to refresh it. pi-tui's `Component` already has it. */
interface Invalidatable {
  invalidate(): void;
}

/**
 * Flatten the editor's line/column cursor to an offset into `getText()`, which
 * is the coordinate the row renderers draw a caret at. The `+ 1` per line is
 * the newline `getText()` joins with.
 */
function getInputCursorOffset(input: Editor): number {
  const lines = input.getLines();
  const cursor = input.getCursor();
  let offset = cursor.col;
  for (let i = 0; i < cursor.line; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset;
}

export interface QuestionnairePropsAdapterConfig {
  tui: { requestRender(): void };
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  tabsByIndex: ReadonlyArray<TabComponents>;
  inlineInput: Editor;
  globalBindings: ReadonlyArray<BoundGlobalBinding>;
  perTabBindings: ReadonlyArray<BoundPerTabBinding>;
  /**
   * Renderables the binding registries do not reach — the notes `Editor`, which
   * is typed into directly and has no props. Walked by `invalidate()` after the
   * bound components.
   */
  extraInvalidatables?: ReadonlyArray<Invalidatable>;
}

/**
 * View fan-out. Every component setter is driven from canonical state through
 * two registries: `globalBindings` for the cross-tab components (dialog, submit
 * picker, tab bar), `perTabBindings` for the per-tab kinds (option list,
 * preview, multi-select). One global loop and one nested per-tab loop replace a
 * hand-written fan-out that had to be edited every time a component was added.
 *
 * The inline-Other text is read off the headless `inlineInput` once per tick
 * and put in the context, so the row selectors see the live value without any
 * component reaching for the editor itself.
 */
export class QuestionnairePropsAdapter {
  private readonly tui: QuestionnairePropsAdapterConfig["tui"];
  private readonly questions: readonly QuestionData[];
  private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  private readonly tabsByIndex: ReadonlyArray<TabComponents>;
  private readonly inlineInput: Editor;
  private readonly globalBindings: ReadonlyArray<BoundGlobalBinding>;
  private readonly perTabBindings: ReadonlyArray<BoundPerTabBinding>;
  private readonly extraInvalidatables: ReadonlyArray<Invalidatable>;

  constructor(config: QuestionnairePropsAdapterConfig) {
    this.tui = config.tui;
    this.questions = config.questions;
    this.itemsByTab = config.itemsByTab;
    this.tabsByIndex = config.tabsByIndex;
    this.inlineInput = config.inlineInput;
    this.globalBindings = config.globalBindings;
    this.perTabBindings = config.perTabBindings;
    this.extraInvalidatables = config.extraInvalidatables ?? [];
  }

  apply(state: QuestionnaireState): void {
    const totalQuestions = this.questions.length;
    const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
    const firstTab = this.tabsByIndex[0];
    // Unreachable in practice: validation caps a questionnaire at 1-4 questions,
    // so there is always a tab. Skipping the tick beats asserting non-null and
    // throwing out of a render path if that ever stops being true.
    const activePreviewPane = this.tabsByIndex[paneIndex]?.preview ?? firstTab?.preview;
    if (!activePreviewPane) return;

    const ctx: BindingContext = {
      questions: this.questions,
      itemsByTab: this.itemsByTab,
      totalQuestions,
      activeView: selectActiveView(state, totalQuestions),
      inputBuffer: this.inlineInput.getText(),
      inputCursorOffset: getInputCursorOffset(this.inlineInput),
      activePreviewPane,
    };

    for (const binding of this.globalBindings) binding.apply(state, ctx);

    for (let i = 0; i < this.tabsByIndex.length; i++) {
      const tab = this.tabsByIndex[i];
      if (!tab) continue;
      const tabCtx: PerTabBindingContext = { ...ctx, tab, i };
      for (const binding of this.perTabBindings) binding.apply(state, tabCtx);
    }

    this.tui.requestRender();
  }

  /**
   * Invalidate every renderable this adapter owns. The session calls this
   * instead of the old `dialog.invalidate()` chain: the dialog no longer reaches
   * sideways into the tab bar, the notes editor or the active preview pane to
   * refresh them. Walks the same registries `apply()` does, then the extras.
   */
  invalidate(): void {
    for (const b of this.globalBindings) b.invalidate();
    for (const tab of this.tabsByIndex) {
      tab.optionList.invalidate();
      tab.preview.invalidate();
      tab.multiSelect?.invalidate();
    }
    for (const x of this.extraInvalidatables) x.invalidate();
  }
}
