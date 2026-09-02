import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Editor, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, formatKeySpecForDisplay } from "../config.js";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import {
  COLLAPSED_HINT_TEMPLATE,
  HINT_PART_CANCEL,
  KEY_PLACEHOLDER,
} from "../view/dialog-builder.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire, type QuestionnaireBuilt } from "./build-questionnaire.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import type { WrappingSelectItem } from "./row-intent.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";

export interface QuestionnaireSessionConfig {
  tui: TUI;
  theme: Theme;
  params: QuestionParams;
  itemsByTab: WrappingSelectItem[][];
  done: (result: QuestionnaireResult) => void;
  keybindings: QuestionnaireRuntime["keybindings"];
  /** Opens Pi's configured external editor. Resolves undefined when the launch failed. */
  editInput: (value: string) => Promise<string | undefined>;
  /** Resolved collapse key, e.g. `"ctrl+]"`, `"alt+o"` or `"off"`. */
  collapseKey: string;
  /**
   * Whether a raw terminal-input listener is registered, which is the only
   * thing that can reach a hidden overlay.
   *
   * This gates hiding, and it has to. Pi routes no input to a hidden overlay,
   * so on a host that hands out an `OverlayHandle` but no raw terminal input,
   * hiding would put the dialog somewhere nothing can bring it back from. That
   * host gets the visible one-line collapsed row instead, which keeps focus and
   * keeps receiving keys.
   */
  canReopenWhileHidden: boolean;
}

export interface QuestionnaireSessionComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    answers: new Map(),
    multiSelectChecked: new Set(),
    customDraftsByTab: new Map(),
    notesByTab: new Map(),
    submitChoiceIndex: 0,
    notesDraft: "",
    collapsed: false,
  };
}

/**
 * The runtime, and the only impure thing in the design.
 *
 * It owns the canonical state cell, the two headless editors, and the effect
 * runner. Everything that decides what should happen is elsewhere and pure:
 * `routeKey` turns a keystroke into an action, `reduce` turns an action into a
 * new state plus a list of effects. This class does what those say, in order,
 * and then asks the adapter to re-project.
 */
export class QuestionnaireSession {
  private state: QuestionnaireState = initialState();

  private readonly questions: readonly QuestionData[];
  private readonly isMulti: boolean;
  private readonly itemsByTab: WrappingSelectItem[][];

  private readonly notesInput: Editor;
  private readonly inlineInput: Editor;
  private readonly viewAdapter: QuestionnairePropsAdapter;
  private readonly keybindings: QuestionnaireRuntime["keybindings"];
  private readonly editInput: QuestionnaireSessionConfig["editInput"];
  private readonly collapseKey: string;
  private readonly canReopenWhileHidden: boolean;
  private inputEditorOpen = false;

  /**
   * Arrives from `ctx.ui.custom`'s `onHandle` callback, just after the overlay
   * exists. Lets the session tell Pi's overlay stack that the dialog is hidden,
   * so overlay-aware extensions can behave normally while it is collapsed.
   */
  private overlayHandle: OverlayHandle | undefined;

  private readonly tui: QuestionnaireSessionConfig["tui"];
  private readonly done: QuestionnaireSessionConfig["done"];
  readonly component: QuestionnaireSessionComponent;

  constructor(config: QuestionnaireSessionConfig) {
    this.tui = config.tui;
    this.done = config.done;
    this.questions = config.params.questions;
    this.isMulti = this.questions.length > 1;
    this.itemsByTab = config.itemsByTab;
    this.keybindings = config.keybindings;
    this.editInput = config.editInput;
    this.collapseKey = config.collapseKey;
    this.canReopenWhileHidden = config.canReopenWhileHidden;

    const built = buildQuestionnaire({
      tui: this.tui,
      theme: config.theme,
      questions: this.questions,
      itemsByTab: this.itemsByTab,
      isMulti: this.isMulti,
      initialState: this.state,
      getCurrentTab: () => this.state.currentTab,
      collapseKey: this.collapseKey,
    });

    this.notesInput = built.notesInput;
    this.inlineInput = built.inlineInput;
    this.viewAdapter = built.adapter;

    this.component = this.assembleComponent(built, config.theme);
    this.viewAdapter.apply(this.state);
  }

  private assembleComponent(
    built: QuestionnaireBuilt,
    theme: Theme,
  ): QuestionnaireSessionComponent {
    const collapsedRender = this.buildCollapsedRender(theme);
    return {
      render: (width) => (this.state.collapsed ? collapsedRender(width) : built.render(width)),
      invalidate: built.invalidate,
      handleInput: (data) => this.dispatch(data),
    };
  }

  /**
   * The collapsed rendering: one dim row.
   *
   * Pi sizes an overlay to the number of lines it returns, so returning one
   * line shrinks a full-height bottom-anchored dialog to a single row and makes
   * the transcript behind it readable. The overlay stays focused and in the
   * stack, so the collapse key still arrives here to expand it again.
   *
   * With the shortcut off the router never toggles this, but
   * `toggleCollapsedExternal` is a public entry that is not gated, so the line
   * falls back to cancel-only rather than telling the user to press "Off".
   */
  private buildCollapsedRender(theme: Theme): (width: number) => string[] {
    const collapseKeyDisplay = formatKeySpecForDisplay(this.collapseKey);
    const hint =
      this.collapseKey === COLLAPSE_KEY_OFF
        ? HINT_PART_CANCEL
        : COLLAPSED_HINT_TEMPLATE.replace(KEY_PLACEHOLDER, collapseKeyDisplay);
    return (_width: number): string[] => [theme.fg("dim", ` ${hint} `)];
  }

  dispatch(data: string): void {
    if (this.inputEditorOpen) return;
    const action = routeKey(data, this.state, this.runtime());
    if (action.kind === "ignore") {
      this.handleIgnoreInline(data);
      return;
    }
    this.commit(action);
  }

  private commit(action: QuestionnaireAction): void {
    const result = reduce(this.state, action, this.applyContext());
    this.state = result.state;
    for (const effect of result.effects) this.runEffect(effect);
    this.state = this.mirrorNotesDraft(this.state);
    this.viewAdapter.apply(this.state);
  }

  /**
   * Keep the stored notes draft in step with the editor.
   *
   * Read expanded rather than plain: restoring a draft goes through
   * `Editor.setText`, which clears the editor's paste map, so a draft stored in
   * its collapsed form would come back with a paste marker pointing at nothing.
   */
  private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
    const draft = this.notesInput.getExpandedText?.() ?? this.notesInput.getText();
    return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
  }

  private runEffect(effect: Effect): void {
    switch (effect.kind) {
      case "set_input_buffer":
        this.inlineInput.setText(effect.value);
        return;
      case "clear_input_buffer":
        this.inlineInput.setText("");
        return;
      case "open_input_editor":
        this.openInputEditorAsync(effect.value);
        return;
      case "set_notes_value":
        this.notesInput.setText(effect.value);
        return;
      case "set_notes_focused":
        this.notesInput.focused = effect.focused;
        return;
      case "forward_notes_keystroke":
        this.notesInput.handleInput(effect.data);
        return;
      case "set_overlay_hidden":
        // A no-op until the handle arrives, and suppressed entirely without a
        // raw terminal listener: see `canReopenWhileHidden`. The state still
        // says collapsed either way, so the view renders the one-line row.
        if (this.canReopenWhileHidden) this.overlayHandle?.setHidden(effect.hidden);
        return;
      case "done":
        this.done(effect.result);
        return;
    }
  }

  /**
   * Hand the draft to the external editor and take back whatever comes out.
   *
   * Dispatch is suspended for the duration: the terminal belongs to the editor,
   * and keystrokes meant for it must not also be routed into the dialog. A
   * reported launch failure keeps the draft rather than replacing it with
   * nothing.
   */
  private openInputEditorAsync(value: string): void {
    if (this.inputEditorOpen) return;
    this.inputEditorOpen = true;
    void this.editInput(value).then(
      (edited) => {
        this.inputEditorOpen = false;
        if (edited !== undefined) this.commit({ kind: "input_replace", value: edited });
      },
      () => {
        this.inputEditorOpen = false;
      },
    );
  }

  /**
   * The per-keystroke fast path for text the router does not claim.
   *
   * Editing is delegated wholesale to Pi's headless editor, which is what gives
   * the custom-answer row paste, undo, cursor movement and the user's own
   * newline keybinding for free. The adapter then reads its public text and
   * cursor, so none of this needs a trip through the reducer.
   */
  private handleIgnoreInline(data: string): void {
    if (!this.state.inputMode) return;
    this.inlineInput.handleInput(data);
    this.viewAdapter.apply(this.state);
  }

  private runtime(): QuestionnaireRuntime {
    const cursor = this.inlineInput.getCursor();
    const lastLine = this.inlineInput.getLines().length - 1;
    return {
      keybindings: this.keybindings,
      inputBuffer: this.inlineInput.getExpandedText?.() ?? this.inlineInput.getText(),
      canMoveInputUp: cursor.line > 0,
      canMoveInputDown: cursor.line < lastLine,
      questions: this.questions,
      isMulti: this.isMulti,
      currentItem: this.currentItem(),
      items: this.itemsByTab[this.state.currentTab] ?? [],
      collapseKey: this.collapseKey,
    };
  }

  private applyContext(): ApplyContext {
    return { questions: this.questions, itemsByTab: this.itemsByTab };
  }

  private currentItem(): WrappingSelectItem | undefined {
    const items = this.itemsByTab[this.state.currentTab] ?? [];
    return this.state.optionIndex < items.length ? items[this.state.optionIndex] : undefined;
  }

  /**
   * Called by `ctx.ui.custom`'s `onHandle` once the overlay exists. Before this,
   * hide effects do nothing and the session simply tracks the collapsed flag.
   */
  setOverlayHandle(handle: OverlayHandle): void {
    this.overlayHandle = handle;
  }

  /**
   * The way in for the raw terminal listener.
   *
   * Pi does not route input to a hidden overlay's `handleInput`, so once the
   * dialog is hidden the normal dispatch path can never see the key that would
   * bring it back. The raw listener fires regardless of overlay visibility and
   * comes in here instead. It still goes through `commit`, so the transition
   * stays in the reducer and hiding still happens as an effect like everything
   * else.
   */
  toggleCollapsedExternal(): void {
    if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
  }
}
