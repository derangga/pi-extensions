/**
 * pi-ask-popup — a tabbed questionnaire the model can put to you when it would
 * otherwise guess.
 *
 * Registers `ask_user_question`, plus a reconciler that keeps the tool out of
 * the model's tool list on hosts with no way to show it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskPopupTool } from "./ask-user-question.js";
import { registerAskPopupReconciler } from "./reconcile.js";

export {
  ASK_POPUP_BLOCKED_EVENT,
  ASK_POPUP_PROMPT_EVENT,
  type AskPopupBlockedEventPayload,
  type AskPopupPromptEventPayload,
  type AskPopupPromptOption,
  type AskPopupPromptQuestion,
} from "./events.js";

export default function piAskPopup(pi: ExtensionAPI): void {
  registerAskPopupTool(pi);
  registerAskPopupReconciler(pi);
}
