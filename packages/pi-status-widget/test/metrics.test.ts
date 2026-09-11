import { describe, expect, it } from "vitest";

import { configWithPreset, DEFAULT_CONFIG } from "../src/config.js";
import { collectSessionMetrics, needsMetrics } from "../src/metrics.js";
import { PRESET_VALUES } from "../src/presets.js";
import type { WidgetEntry } from "../src/types.js";
import { registry, type WidgetType } from "../src/widgets/registry.js";
import type { WidgetDependency } from "../src/widgets/types.js";

function entry(type: WidgetType, enabled = true): WidgetEntry {
  return { ...registry.createEntry(type), enabled };
}

function assistant(cost: unknown, timestamp?: unknown): unknown {
  return { message: { role: "assistant", timestamp, usage: { cost: { total: cost } } } };
}

describe("collectSessionMetrics", () => {
  it("reports zero cost and no start time for an empty branch", () => {
    expect(collectSessionMetrics([])).toEqual({ costUsd: 0, firstTimestampMs: undefined });
  });

  it("sums cost across assistant messages", () => {
    const metrics = collectSessionMetrics([assistant(0.25), assistant(0.5), assistant(1)]);
    expect(metrics.costUsd).toBeCloseTo(1.75);
  });

  it("ignores cost reported on a non-assistant message", () => {
    const entries = [
      { message: { role: "user", usage: { cost: { total: 9 } } } },
      { message: { role: "toolResult", usage: { cost: { total: 9 } } } },
      assistant(0.5),
    ];
    expect(collectSessionMetrics(entries).costUsd).toBeCloseTo(0.5);
  });

  it("keeps the earliest timestamp whatever the order or role", () => {
    const entries = [
      assistant(0, 3000),
      { message: { role: "user", timestamp: 1000 } },
      assistant(0, 2000),
    ];
    expect(collectSessionMetrics(entries).firstTimestampMs).toBe(1000);
  });

  it("parses an ISO timestamp string", () => {
    const entries = [assistant(0, "2026-09-03T10:00:00.000Z")];
    expect(collectSessionMetrics(entries).firstTimestampMs).toBe(
      Date.parse("2026-09-03T10:00:00.000Z"),
    );
  });

  it("falls back to the entry timestamp when the message has none", () => {
    const entries = [{ timestamp: 4200, message: { role: "assistant" } }];
    expect(collectSessionMetrics(entries).firstTimestampMs).toBe(4200);
  });

  it("skips a timestamp that will not parse", () => {
    const entries = [assistant(0, "not a date"), assistant(0, Number.NaN), assistant(0, {})];
    expect(collectSessionMetrics(entries).firstTimestampMs).toBeUndefined();
  });

  it("skips entries that do not carry a message record", () => {
    const entries = [null, undefined, 7, "entry", [], { message: "not a record" }, {}];
    expect(collectSessionMetrics(entries)).toEqual({ costUsd: 0, firstTimestampMs: undefined });
  });

  it("treats a cost that is not a finite number as zero", () => {
    const entries = [
      assistant("0.5"),
      assistant(Number.NaN),
      assistant(Number.POSITIVE_INFINITY),
      assistant(null),
      { message: { role: "assistant", usage: "not a record" } },
      { message: { role: "assistant" } },
      assistant(0.25),
    ];
    expect(collectSessionMetrics(entries).costUsd).toBeCloseTo(0.25);
  });
});

describe("needsMetrics", () => {
  it("is false when nothing on the footer reads the snapshot", () => {
    expect(needsMetrics([])).toBe(false);
    expect(needsMetrics([[entry("model"), entry("git-branch")]])).toBe(false);
  });

  it("is true for either widget that reads it", () => {
    expect(needsMetrics([[entry("cost")]])).toBe(true);
    expect(needsMetrics([[entry("total-time")]])).toBe(true);
  });

  it("ignores a metrics widget that is switched off", () => {
    expect(needsMetrics([[entry("model"), entry("cost", false)]])).toBe(false);
  });

  it("ignores a widget type this build does not register", () => {
    expect(needsMetrics([[{ ...entry("cost"), type: "invented" as WidgetType }]])).toBe(false);
  });

  it("answers per preset, and says no to git-heavy", () => {
    // The gate earns its keep here: git-heavy draws neither cost nor elapsed
    // time, so without it every frame walks the whole session for nothing.
    const answers = Object.fromEntries(
      PRESET_VALUES.map((preset) => [
        preset,
        needsMetrics(configWithPreset(DEFAULT_CONFIG, preset).lines),
      ]),
    );
    expect(answers).toEqual({
      default: true,
      compact: true,
      "2-lines": true,
      "git-heavy": false,
    });
  });

  it("reads the declared dependency rather than a list of widget types", () => {
    // Every widget whose spec declares metrics, walked from the registry: one
    // that starts reading the snapshot is covered by saying so in its spec.
    const declared = registry.specs
      .filter((spec) => (spec.dependencies as readonly WidgetDependency[]).includes("metrics"))
      .map((spec) => spec.type);

    expect(declared.length).toBeGreaterThan(0);
    for (const type of declared) {
      expect(needsMetrics([[entry(type)]])).toBe(true);
    }
  });
});
