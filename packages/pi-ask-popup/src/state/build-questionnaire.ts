import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { QuestionData } from "../tool/types.js";
import {
  type BoundGlobalBinding,
  type BoundPerTabBinding,
  globalBinding,
  perTabBinding,
} from "../view/component-binding.js";
import { MultiSelectView } from "../view/components/multi-select-view.js";
import { OptionListView } from "../view/components/option-list-view.js";
import { PreviewBlockRenderer } from "../view/components/preview/preview-block-renderer.js";
import { crossTabLeftWidthWithDonation } from "../view/components/preview/preview-layout-decider.js";
import { PreviewPane, type PreviewPaneProps } from "../view/components/preview/preview-pane.js";
import { SubmitPicker } from "../view/components/submit-picker.js";
import { TabBar } from "../view/components/tab-bar.js";
import type { WrappingSelectTheme } from "../view/components/wrapping-select.js";
import { DialogView } from "../view/dialog-builder.js";
import { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import type { StatefulView } from "../view/stateful-view.js";
import type { TabBodyHeights, TabComponents } from "../view/tab-components.js";
import type { WrappingSelectItem } from "./row-intent.js";
import type { PerTabSelector } from "./selectors/contract.js";
import { selectActivePreviewPaneIndex } from "./selectors/derivations.js";
import {
  selectDialogProps,
  selectMultiSelectProps,
  selectOptionListProps,
  selectPreviewPaneProps,
  selectSubmitPickerProps,
  selectTabBarProps,
} from "./selectors/projections.js";
import type { QuestionnaireState } from "./state.js";

export interface QuestionnaireBuildConfig {
  tui: TUI;
  theme: Theme;
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  isMulti: boolean;
  initialState: QuestionnaireState;
  getCurrentTab: () => number;
  /**
   * Resolved collapse key. Construction-time config threaded into the dialog so
   * the footer can name the key that is really bound, and deliberately not part
   * of canonical state, which stays free of runtime context.
   */
  collapseKey: string;
}

export interface QuestionnaireBuilt {
  adapter: QuestionnairePropsAdapter;
  notesInput: Editor;
  inlineInput: Editor;
  render: (width: number) => string[];
  invalidate: () => void;
}

interface HeightComputers {
  global: (width: number) => number;
  current: (width: number) => number;
}

function previewBodyHeights(pane: PreviewPane): (width: number) => TabBodyHeights {
  return (width) => {
    const current = pane.naturalHeight(width);
    return { current, max: Math.max(current, pane.maxNaturalHeight(width)) };
  };
}

function multiSelectBodyHeights(view: MultiSelectView): (width: number) => TabBodyHeights {
  return (width) => {
    const height = view.naturalHeight(width);
    return { current: height, max: height };
  };
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
      selectedText: (text) => theme.bg("selectedBg", theme.bold(text)),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

const isActiveTab: PerTabSelector<boolean> = (s, ctx) =>
  ctx.i === selectActivePreviewPaneIndex(s.currentTab, ctx.totalQuestions);

/**
 * Assemble every component, the props adapter and a lifecycle handle.
 *
 * Nothing here reads session state directly: the current tab arrives through a
 * getter, and live custom text lives in a headless editor. No selector runs at
 * build time either — the session calls `adapter.apply` once it has the handle,
 * which is what paints the first frame.
 */
export function buildQuestionnaire(config: QuestionnaireBuildConfig): QuestionnaireBuilt {
  return new QuestionnaireBuilder(config).build();
}

/**
 * One private method per construction step, so `build()` reads as the list of
 * things that have to exist. The class is discarded once it returns the handle.
 */
class QuestionnaireBuilder {
  private readonly tui: QuestionnaireBuildConfig["tui"];
  private readonly theme: Theme;
  private readonly questions: readonly QuestionData[];
  private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  private readonly isMulti: boolean;
  private readonly initialState: QuestionnaireState;
  private readonly getCurrentTab: () => number;
  private readonly collapseKey: string;

  private readonly selectTheme: WrappingSelectTheme;
  private readonly markdownTheme = getMarkdownTheme();
  private readonly notesInput: Editor;
  private readonly inlineInput: Editor;
  private readonly getTerminalWidth = () => this.tui.terminal.columns;
  private readonly getTerminalRows = () => this.tui.terminal.rows;

  constructor(config: QuestionnaireBuildConfig) {
    this.tui = config.tui;
    this.theme = config.theme;
    this.questions = config.questions;
    this.itemsByTab = config.itemsByTab;
    this.isMulti = config.isMulti;
    this.initialState = config.initialState;
    this.getCurrentTab = config.getCurrentTab;
    this.collapseKey = config.collapseKey;

    this.selectTheme = this.makeSelectTheme();
    const textEditorTheme = editorTheme(this.theme);
    this.notesInput = new Editor(this.tui, textEditorTheme);
    this.inlineInput = new Editor(this.tui, textEditorTheme);
    // The key router owns confirm and submit; keys that reach these editors are
    // text editing only. Without this, a submit keybinding matched inside
    // `Editor.handleInput` calls `submitValue()`, which resets the buffer — and
    // since no `onSubmit` is wired here, whatever the user had typed is gone
    // with no way to get it back.
    this.notesInput.disableSubmit = true;
    this.inlineInput.disableSubmit = true;
  }

  build(): QuestionnaireBuilt {
    const tabs = this.buildTabComponents();
    this.injectGlobalLeftWidth(tabs);
    const submitPicker = this.buildSubmitPicker();
    const tabBar = this.buildTabBar();
    const heights = this.buildHeightComputers(tabs);
    const dialog = this.buildDialog(tabs, submitPicker, tabBar, heights);
    const globalBindings = this.buildGlobalBindings(dialog, submitPicker, tabBar);
    const perTabBindings = this.buildPerTabBindings();
    const adapter = this.buildAdapter(tabs, globalBindings, perTabBindings);
    return this.handle(adapter, dialog);
  }

  private makeSelectTheme(): WrappingSelectTheme {
    const theme = this.theme;
    return {
      selectedText: (s) => theme.fg("accent", theme.bold(s)),
      description: (s) => theme.fg("muted", s),
      scrollInfo: (s) => theme.fg("dim", s),
    };
  }

  private buildTabComponents(): ReadonlyArray<TabComponents> {
    return this.questions.map((q, i) => this.buildTabFor(q, i));
  }

  private buildTabFor(question: QuestionData, index: number): TabComponents {
    const optionList = new OptionListView({
      items: this.itemsByTab[index] ?? [],
      theme: this.selectTheme,
    });
    const previewBlock = new PreviewBlockRenderer({
      question,
      theme: this.theme,
      markdownTheme: this.markdownTheme,
    });
    const preview = new PreviewPane({
      question,
      getTerminalWidth: this.getTerminalWidth,
      optionListView: optionList,
      previewBlock,
    });
    if (question.multiSelect === true) {
      const multiSelect = new MultiSelectView(this.theme, question);
      return {
        optionList,
        preview,
        multiSelect,
        bodyHeights: multiSelectBodyHeights(multiSelect),
      };
    }
    return { optionList, preview, bodyHeights: previewBodyHeights(preview) };
  }

  /**
   * Give every pane the same adaptive left-column width, taken across all tabs.
   *
   * Done before anything renders, and shared rather than per-tab, because the
   * option column jumping width as the user tabs between questions is far more
   * distracting than a column slightly wider than one tab needs.
   */
  private injectGlobalLeftWidth(tabs: ReadonlyArray<TabComponents>): void {
    const questions = this.questions;
    const itemsByTab = this.itemsByTab;
    // The questions are the tab descriptor. Mapping them into `{ multiSelect }`
    // objects first, as upstream did, only produced a shape that already
    // existed -- and produced it with an explicit undefined, which is a
    // different type from an absent key here.
    const globalLeftWidth = (paneWidth: number): number =>
      crossTabLeftWidthWithDonation(questions, itemsByTab, questions, paneWidth);
    for (const tab of tabs) {
      tab.preview.setGlobalLeftWidth(globalLeftWidth);
    }
  }

  private buildSubmitPicker(): SubmitPicker | undefined {
    return this.isMulti ? new SubmitPicker(this.theme) : undefined;
  }

  private buildTabBar(): TabBar | undefined {
    return this.isMulti ? new TabBar(this.theme) : undefined;
  }

  private buildHeightComputers(tabs: ReadonlyArray<TabComponents>): HeightComputers {
    const global = (width: number): number => {
      let max = 0;
      for (const tab of tabs) {
        const h = tab.bodyHeights(width).max;
        if (h > max) max = h;
      }
      return Math.max(1, max);
    };
    const current = (width: number): number => {
      const idx = Math.min(this.getCurrentTab(), tabs.length - 1);
      return Math.max(0, tabs[idx]?.bodyHeights(width).current ?? 0);
    };
    return { global, current };
  }

  private pickInitialActivePreview(
    tabs: ReadonlyArray<TabComponents>,
  ): StatefulView<PreviewPaneProps> | undefined {
    const idx = selectActivePreviewPaneIndex(this.initialState.currentTab, this.questions.length);
    return tabs[idx]?.preview ?? tabs[0]?.preview;
  }

  private buildDialog(
    tabs: ReadonlyArray<TabComponents>,
    submitPicker: SubmitPicker | undefined,
    tabBar: TabBar | undefined,
    heights: HeightComputers,
  ): DialogView {
    const activePreviewPane = this.pickInitialActivePreview(tabs);
    if (!activePreviewPane) {
      // Validation caps a questionnaire at one to four questions, so there is
      // always a tab. Saying so out loud beats a non-null assertion that would
      // fail as a property access on undefined at first paint.
      throw new Error("buildQuestionnaire requires at least one question");
    }
    return new DialogView(
      {
        theme: this.theme,
        questions: this.questions,
        tabBar,
        notesInput: this.notesInput,
        isMulti: this.isMulti,
        tabsByIndex: tabs,
        ...(submitPicker === undefined ? {} : { submitPicker }),
        getBodyHeight: heights.global,
        getCurrentBodyHeight: heights.current,
        getTerminalRows: this.getTerminalRows,
        collapseKey: this.collapseKey,
      },
      { state: this.initialState, activePreviewPane },
    );
  }

  private buildGlobalBindings(
    dialog: DialogView,
    submitPicker: SubmitPicker | undefined,
    tabBar: TabBar | undefined,
  ): ReadonlyArray<BoundGlobalBinding> {
    return [
      globalBinding({ component: dialog, select: selectDialogProps }),
      ...(submitPicker
        ? [globalBinding({ component: submitPicker, select: selectSubmitPickerProps })]
        : []),
      ...(tabBar ? [globalBinding({ component: tabBar, select: selectTabBarProps })] : []),
    ];
  }

  private buildPerTabBindings(): ReadonlyArray<BoundPerTabBinding> {
    return [
      perTabBinding({
        resolve: (tab) => tab.optionList,
        predicate: isActiveTab,
        select: selectOptionListProps,
      }),
      perTabBinding({
        resolve: (tab) => tab.preview,
        predicate: isActiveTab,
        select: selectPreviewPaneProps,
      }),
      perTabBinding({
        resolve: (tab) => tab.multiSelect,
        select: selectMultiSelectProps,
      }),
    ];
  }

  private buildAdapter(
    tabs: ReadonlyArray<TabComponents>,
    globalBindings: ReadonlyArray<BoundGlobalBinding>,
    perTabBindings: ReadonlyArray<BoundPerTabBinding>,
  ): QuestionnairePropsAdapter {
    return new QuestionnairePropsAdapter({
      tui: this.tui,
      questions: this.questions,
      itemsByTab: this.itemsByTab,
      tabsByIndex: tabs,
      inlineInput: this.inlineInput,
      globalBindings,
      perTabBindings,
      extraInvalidatables: [this.notesInput],
    });
  }

  private handle(adapter: QuestionnairePropsAdapter, dialog: DialogView): QuestionnaireBuilt {
    return {
      adapter,
      notesInput: this.notesInput,
      inlineInput: this.inlineInput,
      render: (w) => dialog.render(w),
      invalidate: () => adapter.invalidate(),
    };
  }
}
