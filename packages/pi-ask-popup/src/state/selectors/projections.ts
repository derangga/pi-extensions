import {
  MULTI_SUBMIT_LABEL,
  type MultiSelectViewProps,
} from "../../view/components/multi-select-view.js";
import type { OptionListViewProps } from "../../view/components/option-list-view.js";
import type { PreviewPaneProps } from "../../view/components/preview/preview-pane.js";
import type { SubmitPickerProps } from "../../view/components/submit-picker.js";
import type { TabBarProps } from "../../view/components/tab-bar.js";
import type { DialogProps } from "../../view/dialog-builder.js";
import { LABELS_BY_KIND } from "../row-intent.js";
import { noteForTab } from "../state.js";
import type { GlobalSelector, PerTabBindingContext, PerTabSelector } from "./contract.js";
import { selectConfirmedIndicator } from "./derivations.js";

/** Header text for a tab, falling back to a position when the author gave none. */
function tabLabel(header: string | undefined, index: number): string {
  return header !== undefined && header.length > 0 ? header : `Q${index + 1}`;
}

function emptyMultiSelectProps(ctx: PerTabBindingContext): MultiSelectViewProps {
  return {
    rows: [],
    other: {
      active: false,
      inputMode: false,
      inputBuffer: ctx.inputBuffer,
      inputCursorOffset: ctx.inputCursorOffset,
    },
    nextActive: false,
    nextLabel: LABELS_BY_KIND.next,
  };
}

/**
 * The commit row reads "Next" on every question but the last, where advancing
 * has nowhere to go and the row submits instead. Both strings come from the
 * layer that owns them: the row's own metadata, and the multi-select view's
 * submit label.
 */
function nextLabelFor(ctx: PerTabBindingContext): string {
  const isLastQuestion = ctx.i === ctx.questions.length - 1;
  return isLastQuestion ? MULTI_SUBMIT_LABEL : LABELS_BY_KIND.next;
}

export const selectMultiSelectProps: PerTabSelector<MultiSelectViewProps> = (state, ctx) => {
  const question = ctx.questions[ctx.i];
  if (!question) return emptyMultiSelectProps(ctx);
  const focused = ctx.activeView === "options";
  const rows = question.options.map((_option, i) => ({
    checked: state.multiSelectChecked.has(i),
    active: focused && i === state.optionIndex,
  }));
  return {
    rows,
    other: {
      active: focused && state.optionIndex === question.options.length,
      inputMode: state.inputMode,
      inputBuffer: ctx.inputBuffer,
      inputCursorOffset: ctx.inputCursorOffset,
    },
    nextActive: focused && state.optionIndex === question.options.length + 1,
    nextLabel: nextLabelFor(ctx),
  };
};

export const selectOptionListProps: PerTabSelector<OptionListViewProps> = (state, ctx) => {
  const items = ctx.itemsByTab[ctx.i] ?? [];
  const confirmed = selectConfirmedIndicator(ctx.questions, state.currentTab, state.answers, items);
  return {
    selectedIndex: state.optionIndex,
    focused: ctx.activeView === "options",
    inputBuffer: ctx.inputBuffer,
    inputCursorOffset: ctx.inputCursorOffset,
    ...(confirmed ? { confirmed } : {}),
  };
};

export const selectSubmitPickerProps: GlobalSelector<SubmitPickerProps> = (state, ctx) => {
  const focused = ctx.activeView === "submit";
  return {
    rows: [
      { active: focused && state.submitChoiceIndex === 0 },
      { active: focused && state.submitChoiceIndex === 1 },
    ],
  };
};

export const selectPreviewPaneProps: PerTabSelector<PreviewPaneProps> = (state, ctx) => ({
  notesVisible: state.notesVisible,
  selectedIndex: state.optionIndex,
  focused: ctx.activeView === "options",
  inputMode: state.inputMode,
});

export const selectTabBarProps: GlobalSelector<TabBarProps> = (state, ctx) => ({
  tabs: ctx.questions.map((q, i) => ({
    label: tabLabel(q.header, i),
    answered: state.answers.has(i),
    active: i === state.currentTab,
    noted: noteForTab(state, i).length > 0,
  })),
  submit: {
    active: state.currentTab === ctx.questions.length,
    allAnswered: state.answers.size === ctx.questions.length && ctx.questions.length > 0,
  },
});

export const selectDialogProps: GlobalSelector<DialogProps> = (state, ctx) => ({
  state,
  activePreviewPane: ctx.activePreviewPane,
});
