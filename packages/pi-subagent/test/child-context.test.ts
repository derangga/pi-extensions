import { describe, expect, it } from "vitest";

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
});
