import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Editor } from "@earendil-works/pi-tui";
import {
  selectMultiSelectProps,
  selectSubmitPickerProps,
} from "../src/state/selectors/projections.js";
import type { QuestionnaireState } from "../src/state/state.js";
import type { QuestionData } from "../src/tool/types.js";
import { MultiSelectView } from "../src/view/components/multi-select-view.js";
import type { OptionListView } from "../src/view/components/option-list-view.js";
import type { PreviewPane } from "../src/view/components/preview/preview-pane.js";
import { SubmitPicker } from "../src/view/components/submit-picker.js";
import type { TabBar } from "../src/view/components/tab-bar.js";
import type { DialogConfig, DialogProps, DialogState } from "../src/view/dialog-builder.js";
import { DialogView } from "../src/view/dialog-builder.js";
import type { TabComponents } from "../src/view/tab-components.js";
import { makePerTabContext, makeQuestionnaireState, makeTheme } from "./fixtures.js";

/**
 * Shared rig for the chrome suites. The dialog is the one component that only
 * composes others, so every test here feeds it stubs with known row counts and
 * then asserts on the arithmetic: which rows are sticky, where the scroll
 * window lands, how tall the whole thing comes out.
 *
 * The stubs render fixed marker strings rather than real content. That is the
 * point — a real body would make a height assertion depend on text wrapping,
 * and the thing under test is the partition, not the wrapping.
 */

export const theme = makeTheme() as unknown as Theme;

export function stubComponent(lines: string[]): Component {
  return { render: () => lines, handleInput() {}, invalidate() {} };
}

export function stubPreviewPane(
  lines: string[],
  rowRange?: (width: number) => [number, number],
): PreviewPane {
  return {
    ...stubComponent(lines),
    focusedItemRowRange: rowRange ?? ((_w: number) => [0, 1] as [number, number]),
  } as unknown as PreviewPane;
}

export function stubMultiSelect(
  lines: string[],
  rowRange?: (width: number) => [number, number],
): MultiSelectView {
  return {
    ...stubComponent(lines),
    focusedItemRowRange: rowRange ?? ((_w: number) => [0, 0] as [number, number]),
    naturalHeight: (_w: number) => lines.length,
  } as unknown as MultiSelectView;
}

export function stubOptionList(): OptionListView {
  return stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView;
}

/**
 * A real `MultiSelectView` holding the props the adapter would have given it.
 * Runs the shipped projection rather than a fixture copy, so a change in how
 * rows are marked reaches these tests too.
 */
export function multiSelectFor(
  question: QuestionData,
  state: QuestionnaireState,
  questions: readonly QuestionData[],
): MultiSelectView {
  const view = new MultiSelectView(theme, question);
  view.setProps(selectMultiSelectProps(state, makePerTabContext({ questions, i: 0 })));
  return view;
}

export function submitPickerFor(state: QuestionnaireState, focused = true): SubmitPicker {
  const picker = new SubmitPicker(theme);
  picker.setProps(
    selectSubmitPickerProps(
      state,
      makePerTabContext({ activeView: focused ? "submit" : "options" }),
    ),
  );
  return picker;
}

export const DEFAULT_QUESTIONS: QuestionData[] = [
  {
    question: "Q1?",
    header: "H1",
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  },
  {
    question: "Q2?",
    header: "H2",
    options: [
      { label: "X", description: "x" },
      { label: "Y", description: "y" },
    ],
  },
];

export const MULTI_QUESTION: QuestionData = {
  question: "areas?",
  header: "Areas",
  multiSelect: true,
  options: [
    { label: "FE", description: "FE" },
    { label: "BE", description: "BE" },
  ],
};

export type MakeConfigOverrides = Partial<Omit<DialogConfig, "tabsByIndex">> & {
  state?: DialogState;
  previewPane?: PreviewPane;
  tabsByIndex?: ReadonlyArray<TabComponents>;
  multiSelectByTab?: ReadonlyArray<MultiSelectView | undefined>;
};

export interface DialogParts {
  config: DialogConfig;
  initialProps: DialogProps;
}

export function makeConfig(over: MakeConfigOverrides = {}): DialogParts {
  const questions: QuestionData[] = over.questions ? [...over.questions] : DEFAULT_QUESTIONS;
  const state: DialogState = over.state ?? makeQuestionnaireState();
  const previewPane = over.previewPane ?? stubPreviewPane(["<PREVIEW>"]);
  const tabsByIndex: ReadonlyArray<TabComponents> =
    over.tabsByIndex ??
    questions.map((_q, i) => {
      const multiSelect = over.multiSelectByTab?.[i];
      return {
        optionList: stubOptionList(),
        preview: previewPane,
        ...(multiSelect === undefined ? {} : { multiSelect }),
        bodyHeights: () => ({ current: 0, max: 0 }),
      };
    });
  const config: DialogConfig = {
    theme: over.theme ?? theme,
    questions,
    tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
    notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Editor),
    isMulti: over.isMulti ?? questions.length > 1,
    tabsByIndex,
    ...(over.submitPicker === undefined ? {} : { submitPicker: over.submitPicker }),
    getBodyHeight: over.getBodyHeight ?? (() => 1),
    // Measures whichever body the current tab actually shows, so a test that
    // swaps in a taller stub does not also have to restate its height.
    getCurrentBodyHeight:
      over.getCurrentBodyHeight ??
      ((w) => {
        const q = questions[state.currentTab];
        const multiSelect = tabsByIndex[state.currentTab]?.multiSelect;
        if (q?.multiSelect === true && multiSelect) {
          return (multiSelect as unknown as Component).render(w).length;
        }
        return (previewPane as unknown as Component).render(w).length;
      }),
    getTerminalRows: over.getTerminalRows ?? (() => 24),
    collapseKey: over.collapseKey ?? "ctrl+]",
  };
  return { config, initialProps: { state, activePreviewPane: previewPane } };
}

export function makeDialog(parts: DialogParts): DialogView {
  return new DialogView(parts.config, parts.initialProps);
}

export function renderDialog(over: MakeConfigOverrides = {}, width = 80): string[] {
  return makeDialog(makeConfig(over)).render(width);
}

export function renderJoined(over: MakeConfigOverrides = {}, width = 80): string {
  return renderDialog(over, width).join("\n");
}
