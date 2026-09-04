import { beforeEach, describe, expect, it } from "vitest";

import { asyncCache } from "../src/cache.js";
import { collectStatusbarData } from "../src/data.js";
import { EMPTY_GIT_INFO, type GitCommand } from "../src/git.js";
import { stubApi, stubContext, type ContextOptions } from "./helpers/pi.js";

function collect(options: ContextOptions = {}, commands?: readonly GitCommand[]) {
  const api = stubApi();
  const { ctx } = stubContext(options);
  const data = collectStatusbarData({
    ctx,
    pi: api.pi,
    branchHint: "main",
    gitCommands: commands ? new Set(commands) : undefined,
    requestRender: () => {},
  });
  return { data, api };
}

describe("collectStatusbarData", () => {
  beforeEach(() => {
    asyncCache.clear();
  });

  it("projects the model, provider, cwd and context usage from the context", () => {
    const { data } = collect();

    expect(data.model).toBe("opus");
    expect(data.provider).toBe("anthropic");
    expect(data.cwd).toBe("/repo");
    expect(data.contextTokens).toBe(100);
    expect(data.contextMaxTokens).toBe(1000);
  });

  it("reads the thinking level for a model that reasons", () => {
    expect(collect().data.thinkingLevel).toBe("high");
  });

  it("leaves the thinking level unset for a model that does not reason", () => {
    // Asking anyway returns Pi's default level, which would paint a colour for a
    // level the model never uses.
    const { data } = collect({ model: { id: "haiku", provider: "anthropic" } });
    expect(data.thinkingLevel).toBeUndefined();
  });

  it("survives having no model at all", () => {
    const { data } = collect({ model: undefined });

    expect(data.model).toBeUndefined();
    expect(data.thinkingLevel).toBeUndefined();
    expect(data.usingSubscription).toBe(false);
  });

  it("reports a subscription when the registry says the model runs on OAuth", () => {
    expect(collect({ usingOAuth: true }).data.usingSubscription).toBe(true);
  });

  it("treats an unknown token count as unknown rather than as zero", () => {
    // tokens is null between a compaction and the next response.
    expect(
      collect({ contextUsage: { tokens: null, contextWindow: 1000 } }).data.contextTokens,
    ).toBeUndefined();
    expect(collect({ contextUsage: undefined }).data.contextTokens).toBeUndefined();
    expect(collect({ contextUsage: undefined }).data.contextMaxTokens).toBeUndefined();
  });

  it("sums session cost from the branch", () => {
    const entries = [
      { message: { role: "assistant", timestamp: 1000, usage: { cost: { total: 0.5 } } } },
      { message: { role: "assistant", timestamp: 2000, usage: { cost: { total: 0.25 } } } },
    ];
    const { data } = collect({ entries });

    expect(data.metrics.costUsd).toBeCloseTo(0.75);
    expect(data.metrics.firstTimestampMs).toBe(1000);
  });

  it("runs no subprocess when no git widget is enabled", () => {
    const { data, api } = collect();

    expect(data.git).toEqual(EMPTY_GIT_INFO);
    expect(api.execCalls).toEqual([]);
  });

  it("collects git when a widget asks for it", () => {
    const { api } = collect({}, ["shortstat"]);

    // Stale-while-revalidate: the first read returns nothing and starts the
    // fetch, so the assertion is that the fetch started at all.
    expect(api.execCalls.length).toBeGreaterThan(0);
  });
});
