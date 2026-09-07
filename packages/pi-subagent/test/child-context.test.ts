import { describe, expect, it, vi } from "vitest";

import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentExtension from "../src/index.js";

describe("child session context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("prevents extension activation in a child", async () => {
    const unusablePi = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`extension touched ${String(property)}`);
        },
      },
    );

    await expect(
      runInChildSessionContext(async () => {
        subagentExtension(unusablePi as never);
      }),
    ).resolves.toBeUndefined();
  });

  it("returns runtime disposal from parent session shutdown", async () => {
    let shutdown: (() => void | Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn<() => void>(),
      registerTool: vi.fn<() => void>(),
      sendUserMessage: vi.fn<() => void>(),
      on: vi.fn<(event: string, handler: () => void | Promise<void>) => void>((event, handler) => {
        if (event === "session_shutdown") shutdown = handler;
      }),
    };

    subagentExtension(pi as never);
    const disposal = shutdown?.();

    expect(disposal).toBeInstanceOf(Promise);
    await disposal;
  });
});
