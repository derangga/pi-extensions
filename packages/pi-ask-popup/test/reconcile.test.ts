import { describe, expect, it } from "vitest";
import { ASK_POPUP_TOOL_NAME } from "../src/ask-user-question.js";
import { reconcileAskPopupTool, registerAskPopupReconciler } from "../src/reconcile.js";
import { createMockCtx, createMockPi } from "./mock-pi.js";

/**
 * The reconciler keeps the tool out of the model's tool list on a host that
 * cannot show it. A model offered a tool it cannot use will call it, fail, and
 * have to recover; not offering it is simply better.
 */

const OTHER = "some_other_tool";

describe("reconcileAskPopupTool", () => {
  it("strips the tool when the host has no UI", () => {
    const mock = createMockPi([ASK_POPUP_TOOL_NAME, OTHER]);
    reconcileAskPopupTool(mock.pi, createMockCtx({ hasUI: false }).ctx);
    expect(mock.activeTools).toEqual([OTHER]);
  });

  it("restores it when the host has one", () => {
    const mock = createMockPi([OTHER]);
    reconcileAskPopupTool(mock.pi, createMockCtx({ hasUI: true }).ctx);
    expect(mock.activeTools).toContain(ASK_POPUP_TOOL_NAME);
  });

  it("leaves sibling tools alone in both directions", () => {
    // Another extension's tools are none of our business, and rewriting the
    // whole list rather than editing it would drop whatever arrived after us.
    const mock = createMockPi([ASK_POPUP_TOOL_NAME, OTHER, "third"]);
    reconcileAskPopupTool(mock.pi, createMockCtx({ hasUI: false }).ctx);
    expect(mock.activeTools).toEqual([OTHER, "third"]);
    reconcileAskPopupTool(mock.pi, createMockCtx({ hasUI: true }).ctx);
    expect(mock.activeTools).toContain(OTHER);
    expect(mock.activeTools).toContain("third");
  });

  it("writes nothing when the tool is already in the right state", () => {
    // Idempotence matters because this runs before every single turn.
    const present = createMockPi([ASK_POPUP_TOOL_NAME]);
    reconcileAskPopupTool(present.pi, createMockCtx({ hasUI: true }).ctx);
    expect(present.setActiveTools).not.toHaveBeenCalled();

    const absent = createMockPi([OTHER]);
    reconcileAskPopupTool(absent.pi, createMockCtx({ hasUI: false }).ctx);
    expect(absent.setActiveTools).not.toHaveBeenCalled();
  });

  it("settles after repeated runs in the same state", () => {
    const mock = createMockPi([ASK_POPUP_TOOL_NAME]);
    const ctx = createMockCtx({ hasUI: false }).ctx;
    reconcileAskPopupTool(mock.pi, ctx);
    reconcileAskPopupTool(mock.pi, ctx);
    reconcileAskPopupTool(mock.pi, ctx);
    expect(mock.activeTools).toEqual([]);
    expect(mock.setActiveTools).toHaveBeenCalledTimes(1);
  });

  it("adds the tool exactly once however many times it runs", () => {
    const mock = createMockPi([]);
    const ctx = createMockCtx({ hasUI: true }).ctx;
    reconcileAskPopupTool(mock.pi, ctx);
    reconcileAskPopupTool(mock.pi, ctx);
    expect(mock.activeTools.filter((n) => n === ASK_POPUP_TOOL_NAME)).toHaveLength(1);
  });

  it("keeps the tool on an RPC host, where the dialog walker works", () => {
    // hasUI is the honest signal. RPC hosts report true and can render the
    // native dialogs, so stripping them would remove a tool that works.
    const mock = createMockPi([ASK_POPUP_TOOL_NAME]);
    reconcileAskPopupTool(mock.pi, createMockCtx({ hasUI: true, mode: "rpc" }).ctx);
    expect(mock.activeTools).toContain(ASK_POPUP_TOOL_NAME);
  });
});

describe("registerAskPopupReconciler", () => {
  it("runs before each turn, when the model's tool list is snapshotted", () => {
    const mock = createMockPi([ASK_POPUP_TOOL_NAME]);
    registerAskPopupReconciler(mock.pi);
    expect(mock.handlers.has("before_agent_start")).toBe(true);
    mock.fire("before_agent_start", createMockCtx({ hasUI: false }).ctx);
    expect(mock.activeTools).toEqual([]);
  });

  it("tracks the host flipping between turns", () => {
    const mock = createMockPi([ASK_POPUP_TOOL_NAME]);
    registerAskPopupReconciler(mock.pi);
    mock.fire("before_agent_start", createMockCtx({ hasUI: false }).ctx);
    expect(mock.activeTools).not.toContain(ASK_POPUP_TOOL_NAME);
    mock.fire("before_agent_start", createMockCtx({ hasUI: true }).ctx);
    expect(mock.activeTools).toContain(ASK_POPUP_TOOL_NAME);
  });
});
