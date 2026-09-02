import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "./row-intent.js";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer read this same shape.
 */
export interface QuestionnaireState {
  currentTab: number;
  optionIndex: number;
  inputMode: boolean;
  notesVisible: boolean;
  answers: ReadonlyMap<number, QuestionAnswer>;
  multiSelectChecked: ReadonlySet<number>;
  /** In-flight custom answers keyed by tab. A present empty string overrides an older answer. */
  customDraftsByTab: ReadonlyMap<number, string>;
  /**
   * Pre-answer notes side-band, keyed by tab index. Decoupled from `answers` so adding
   * notes does NOT mark a question answered (the Submit-tab missing-check would falsely
   * pass otherwise). Merged into the answer at confirm time.
   */
  notesByTab: ReadonlyMap<number, string>;
  /** Focused row in the Submit-tab picker (0 = Submit, 1 = Cancel). Reset on tab switch. */
  submitChoiceIndex: number;
  /** Canonical mirror of the in-flight notes editor; runtime mirrors after `forward_notes_keystroke`. */
  notesDraft: string;
  /**
   * Absolute deadline in epoch milliseconds when the questionnaire should auto-dismiss.
   * Set once at initialization when `timeout` is provided; never reset. Undefined when
   * no timeout is configured.
   */
  deadline?: number | undefined;
  /**
   * Milliseconds remaining until `deadline`. Updated on every `tick`; undefined when
   * no timeout is active or after the timer is cancelled by human input.
   */
  remainingMs?: number | undefined;
  /**
   * Whether the countdown has been cancelled by the first human keystroke.
   * Cancelled outright, not reset — once true it stays true.
   */
  timerCancelled: boolean;
  /**
   * Collapsed mode: the questionnaire gets out of the way so the agent transcript behind
   * the bottom-anchored overlay becomes readable. Toggled by the configured collapse key
   * from any state; while true, every keystroke except cancel is swallowed (see
   * `routeKey`). Two renderings, chosen by host capability:
   *
   * - Hosts with an `OverlayHandle` AND a raw `onTerminalInput` listener (real pi-tui):
   *   the `set_overlay_hidden` effect fully hides the overlay; the raw listener registered
   *   in `execute()` reopens it, because pi-tui routes no input to a hidden overlay.
   * - Hosts without the raw listener (or without a handle): the overlay stays visible and
   *   shrinks to a single hint row. The row keeps focus and input routing, so the same key
   *   expands it and Esc cancels, and the expand key never falls through to an underlying
   *   overlay (e.g. `/btw`). The session gates `set_overlay_hidden` on the listener's
   *   existence (`canReopenWhileHidden`) so a handle-bearing host without raw input can
   *   never hide the overlay into a state nothing can reopen.
   */
  collapsed: boolean;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state. Held separately
 * because `keybindings` / `inputBuffer` must never reach view setProps consumers.
 */
export interface QuestionnaireRuntime {
  keybindings: { matches(data: string, name: string): boolean };
  inputBuffer: string;
  canMoveInputUp: boolean;
  canMoveInputDown: boolean;
  questions: readonly QuestionData[];
  isMulti: boolean;
  currentItem: WrappingSelectItem | undefined;
  items: readonly WrappingSelectItem[];
  /**
   * Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. Resolved
   * from `AskUserQuestionConfig.collapseKey` (or the package default). When `"off"`,
   * the collapse shortcut is disabled.
   */
  collapseKey: string;
}

/**
 * Which of the three focusable surfaces owns the keyboard this tick.
 *
 * Declared here rather than in the view layer because focus is a property of
 * canonical state, not of any renderer: the key router's cascade and the
 * reducer's defensive clears are what enforce mutual exclusion, and components
 * only read the result. Per-component `focused: boolean` flags derive from one
 * equality check against this discriminant instead of parallel boolean reads.
 *
 * Priority order is notes > submit > options, matching the router cascade
 * exactly.
 */
export type ActiveView = "notes" | "options" | "submit";
