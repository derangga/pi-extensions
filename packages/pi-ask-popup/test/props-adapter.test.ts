import { type Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { Editor as PiEditor } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { WrappingSelectItem } from "../src/state/row-intent.js";
import type { PerTabSelector } from "../src/state/selectors/contract.js";
import {
  selectDialogProps,
  selectMultiSelectProps,
  selectOptionListProps,
  selectPreviewPaneProps,
  selectSubmitPickerProps,
  selectTabBarProps,
} from "../src/state/selectors/projections.js";
import type { QuestionAnswer, QuestionData } from "../src/tool/types.js";
import {
  type BoundGlobalBinding,
  type BoundPerTabBinding,
  globalBinding,
  perTabBinding,
} from "../src/view/component-binding.js";
import type { OptionListViewProps } from "../src/view/components/option-list-view.js";
import type { SubmitPickerProps } from "../src/view/components/submit-picker.js";
import type { TabBarProps } from "../src/view/components/tab-bar.js";
import type { DialogProps } from "../src/view/dialog-builder.js";
import { QuestionnairePropsAdapter } from "../src/view/props-adapter.js";
import type { TabComponents } from "../src/view/tab-components.js";
import {
  invalidateCount,
  lastProps,
  makeFakeMultiSelectView,
  makeFakePreviewPane,
  makeQuestion,
  makeQuestionnaireState as makeState,
  makeStatefulView,
  makeTabComponents,
  propsCalls,
} from "./fixtures.js";

function makeFixture(overQuestions?: QuestionData[]) {
  const questions = overQuestions ?? [makeQuestion(), makeQuestion()];
  const itemsByTab: WrappingSelectItem[][] = questions.map(() => [
    { kind: "option", label: "A" },
    { kind: "option", label: "B" },
  ]);

  const tabsByIndex: TabComponents[] = questions.map((q) =>
    makeTabComponents({
      optionList: makeStatefulView<OptionListViewProps>(),
      preview: makeFakePreviewPane(),
      ...(q.multiSelect === true ? { multiSelect: makeFakeMultiSelectView() } : {}),
    }),
  );

  const submitPicker = makeStatefulView<SubmitPickerProps>();
  const tabBar = makeStatefulView<TabBarProps>();
  const dialog = makeStatefulView<DialogProps>();
  const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn<() => void>() };
  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {},
  } as unknown as EditorTheme;
  const inlineInput: Editor = new PiEditor(tui as unknown as TUI, editorTheme);

  const globalBindings: ReadonlyArray<BoundGlobalBinding> = [
    globalBinding({ component: dialog, select: selectDialogProps }),
    globalBinding({ component: submitPicker, select: selectSubmitPickerProps }),
    globalBinding({ component: tabBar, select: selectTabBarProps }),
  ];

  const isActiveTab: PerTabSelector<boolean> = (s, ctx) => {
    const paneIdx = ctx.totalQuestions <= 0 ? 0 : Math.min(s.currentTab, ctx.totalQuestions - 1);
    return ctx.i === paneIdx;
  };

  const perTabBindings: ReadonlyArray<BoundPerTabBinding> = [
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
    perTabBinding({ resolve: (tab) => tab.multiSelect, select: selectMultiSelectProps }),
  ];

  const adapter = new QuestionnairePropsAdapter({
    tui,
    questions,
    itemsByTab,
    tabsByIndex,
    inlineInput,
    globalBindings,
    perTabBindings,
  });
  return { adapter, tui, dialog, tabsByIndex, submitPicker, tabBar, questions, inlineInput };
}

function tabAt(tabs: TabComponents[], index: number): TabComponents {
  const tab = tabs[index];
  if (!tab) throw new Error(`no tab at ${index}`);
  return tab;
}

interface MultiSelectFake {
  setProps: (props: { rows: { active: boolean; checked: boolean }[]; nextLabel: string }) => void;
  invalidate: () => void;
}

function multiSelectAt(tabs: TabComponents[], index: number): MultiSelectFake {
  const multiSelect = tabAt(tabs, index).multiSelect;
  if (!multiSelect) throw new Error(`tab ${index} has no multi-select view`);
  return multiSelect as unknown as MultiSelectFake;
}

describe("QuestionnairePropsAdapter.apply", () => {
  it("pushes state and the resolved pane at the dialog exactly once", () => {
    const { adapter, dialog, tabsByIndex } = makeFixture();
    const state = makeState();
    adapter.apply(state);
    expect(propsCalls(dialog)).toHaveLength(1);
    expect(lastProps(dialog)).toEqual({
      state,
      activePreviewPane: tabAt(tabsByIndex, 0).preview,
    });
  });

  it("drives the active tab's option list and preview pane", () => {
    const { adapter, tabsByIndex } = makeFixture();
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", kind: "option", answer: "B" }],
    ]);
    adapter.apply(makeState({ optionIndex: 1, answers }));
    expect(lastProps(tabAt(tabsByIndex, 0).optionList)).toEqual({
      selectedIndex: 1,
      focused: true,
      inputBuffer: "",
      inputCursorOffset: 0,
      confirmed: { index: 1 },
    });
    expect(lastProps(tabAt(tabsByIndex, 0).preview)).toEqual({
      notesVisible: false,
      selectedIndex: 1,
      focused: true,
      inputMode: false,
    });
  });

  it("takes focus away from the options while the notes editor is open", () => {
    const { adapter, tabsByIndex } = makeFixture();
    adapter.apply(makeState({ notesVisible: true }));
    expect(lastProps(tabAt(tabsByIndex, 0).optionList)).toMatchObject({ focused: false });
  });

  it("focuses the submit picker only on the submit tab, and tracks its selection", () => {
    const { adapter, submitPicker, questions } = makeFixture();
    adapter.apply(makeState({ currentTab: 0 }));
    expect(lastProps(submitPicker)).toEqual({ rows: [{ active: false }, { active: false }] });
    adapter.apply(makeState({ currentTab: questions.length, submitChoiceIndex: 0 }));
    expect(lastProps(submitPicker)).toEqual({ rows: [{ active: true }, { active: false }] });
    adapter.apply(makeState({ currentTab: questions.length, submitChoiceIndex: 1 }));
    expect(lastProps(submitPicker)).toEqual({ rows: [{ active: false }, { active: true }] });
  });

  it("marks answered tabs in the tab bar", () => {
    const { adapter, tabBar } = makeFixture();
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
    ]);
    adapter.apply(makeState({ answers }));
    const props = lastProps(tabBar);
    expect(props.tabs).toHaveLength(2);
    expect(props.tabs[0]).toEqual({ label: "H", answered: true, active: true });
    expect(props.tabs[1]).toEqual({ label: "H", answered: false, active: false });
    expect(props.submit).toEqual({ active: false, allAnswered: false });
  });

  it("requests exactly one render per apply", () => {
    const { adapter, tui } = makeFixture();
    adapter.apply(makeState());
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("writes to every multi-select view, active tab or not", () => {
    // Unlike the option list and preview, these have no active-tab predicate:
    // the chrome may render a multi-select body for a tab the user is not on.
    const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
    const { adapter, tabsByIndex } = makeFixture(questions);
    adapter.apply(makeState());
    const multiSelect = multiSelectAt(tabsByIndex, 0);
    expect(propsCalls(multiSelect)).toHaveLength(1);
    const props = lastProps(multiSelect);
    expect(props.nextLabel).toBe("Next");
    expect(props.rows[0]).toMatchObject({ active: true, checked: false });
  });

  it("labels the commit row Submit on the last question and Next before it", () => {
    const last = makeFixture([makeQuestion(), makeQuestion({ multiSelect: true })]);
    last.adapter.apply(makeState({ currentTab: 1 }));
    expect(lastProps(multiSelectAt(last.tabsByIndex, 1)).nextLabel).toBe("Submit");

    const notLast = makeFixture([makeQuestion({ multiSelect: true }), makeQuestion()]);
    notLast.adapter.apply(makeState({ currentTab: 0 }));
    expect(lastProps(multiSelectAt(notLast.tabsByIndex, 0)).nextLabel).toBe("Next");
  });

  it("projects multiline editor text with a flattened cursor offset", () => {
    // "first\nsecond" puts the caret at the end: 5 + 1 for the newline + 6.
    const { adapter, tabsByIndex, inlineInput } = makeFixture();
    inlineInput.setText("first\nsecond");
    adapter.apply(makeState());
    expect(lastProps(tabAt(tabsByIndex, 0).optionList)).toMatchObject({
      inputBuffer: "first\nsecond",
      inputCursorOffset: 12,
    });
  });

  it("hands the dialog the pane belonging to the current tab", () => {
    const { adapter, dialog, tabsByIndex } = makeFixture();
    adapter.apply(makeState({ currentTab: 1 }));
    expect(lastProps(dialog).activePreviewPane).toBe(tabAt(tabsByIndex, 1).preview);
  });

  it("reuses the last question's pane on the submit tab", () => {
    // The submit tab has no preview of its own; borrowing one keeps the layout
    // width stable instead of collapsing when the user reaches review.
    const { adapter, dialog, tabsByIndex, questions } = makeFixture();
    adapter.apply(makeState({ currentTab: questions.length }));
    expect(lastProps(dialog).activePreviewPane).toBe(tabAt(tabsByIndex, 1).preview);
  });
});

describe("QuestionnairePropsAdapter.invalidate", () => {
  it("reaches every bound component and every per-tab renderable", () => {
    const { adapter, dialog, tabBar, submitPicker, tabsByIndex } = makeFixture([
      makeQuestion({ multiSelect: true }),
      makeQuestion(),
    ]);
    adapter.invalidate();
    for (const view of [dialog, tabBar, submitPicker]) {
      expect(invalidateCount(view)).toBe(1);
    }
    for (const tab of tabsByIndex) {
      expect(invalidateCount(tab.optionList)).toBe(1);
      expect(invalidateCount(tab.preview)).toBe(1);
    }
    expect(invalidateCount(multiSelectAt(tabsByIndex, 0))).toBe(1);
  });

  it("walks the extras the binding registries cannot reach", () => {
    // The notes editor is typed into directly and has no props, so nothing
    // would refresh it if the adapter only walked its bindings.
    const notesInput = makeStatefulView<never>();
    const questions = [makeQuestion()];
    const adapter = new QuestionnairePropsAdapter({
      tui: { requestRender: vi.fn<() => void>() },
      questions,
      itemsByTab: [[]],
      tabsByIndex: [makeTabComponents()],
      inlineInput: new PiEditor(
        {
          terminal: { columns: 80, rows: 24 },
          requestRender: vi.fn<() => void>(),
        } as unknown as TUI,
        { borderColor: (t: string) => t, selectList: {} } as unknown as EditorTheme,
      ),
      globalBindings: [],
      perTabBindings: [],
      extraInvalidatables: [notesInput],
    });
    adapter.invalidate();
    expect(invalidateCount(notesInput)).toBe(1);
  });
});
