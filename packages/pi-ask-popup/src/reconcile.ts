import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_POPUP_TOOL_NAME } from "./ask-user-question.js";

/**
 * Keep the tool out of the model's hands when there is no way to show it.
 *
 * A model offered a tool it cannot use will call it, get an error, and have to
 * recover; not offering it is simply better. `ctx.hasUI` is the honest signal:
 * RPC hosts report true and the dialog walker works there, so they stay.
 *
 * Idempotent by construction. When the tool is already in the right state,
 * nothing is written, so sibling tools another extension added are untouched.
 */
export function reconcileAskPopupTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const active = pi.getActiveTools();
  const hasTool = active.includes(ASK_POPUP_TOOL_NAME);
  if (!ctx.hasUI && hasTool) {
    pi.setActiveTools(active.filter((n) => n !== ASK_POPUP_TOOL_NAME));
  } else if (ctx.hasUI && !hasTool) {
    pi.setActiveTools([...active, ASK_POPUP_TOOL_NAME]);
  }
}

/**
 * Run the reconciler before each turn, which is when the tool list the model
 * sees is snapshotted. The in-handler guards stay as a one-turn backstop in
 * case that ordering ever changes, or a host claims a UI it cannot render with.
 */
export function registerAskPopupReconciler(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, ctx) => reconcileAskPopupTool(pi, ctx));
}
