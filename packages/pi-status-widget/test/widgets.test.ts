import { describe, expect, it } from "vitest";

import { contextForDependencies } from "../src/widgets/context.js";
import { registry, type WidgetType } from "../src/widgets/registry.js";
import { formatCount, formatPiTokenCount } from "../src/widgets/utils/token-format.js";
import { formatElapsed } from "../src/widgets/utils/session.js";
import { baseCtx, statusbarData, type DataOverrides } from "./helpers/data.js";

/**
 * Renders a widget the way the footer does: a config entry through the
 * sanitizer, hydrated into an instance, handed only the data its spec declares.
 * Asserting on the composed output keeps these tests honest about the whole
 * path rather than a widget's render function in isolation.
 */
function render(
  type: WidgetType,
  options: Record<string, unknown> = {},
  data: DataOverrides = {},
): string | undefined {
  const widget = registry.hydrateWidget(registry.createEntry(type, options));
  const ctx = contextForDependencies(
    baseCtx,
    registry.spec(type).dependencies,
    statusbarData(data),
  );
  return widget.render(ctx);
}

describe("model widgets", () => {
  it("shows the model alone, or with its provider when asked", () => {
    expect(render("model")).toBe("🤖 opus");
    expect(render("model", { showProvider: true })).toBe("🤖 anthropic/opus");
    expect(render("model-provider")).toBe("🤖 anthropic/opus");
  });

  it("says no-model rather than going blank when there is none", () => {
    // A footer segment that vanishes reads as a bug in the footer.
    expect(render("model", {}, { model: undefined })).toBe("🤖 no-model");
    expect(render("model-provider", {}, { model: undefined })).toBe("🤖 anthropic/no-model");
  });

  it("omits the provider prefix when the provider is unknown", () => {
    expect(render("model-provider", {}, { provider: undefined })).toBe("🤖 opus");
  });
});

describe("thinking level", () => {
  it("shows the level", () => {
    expect(render("thinking-level")).toBe("🧠 high");
  });

  it("falls back to an empty placeholder rather than a dash", () => {
    // Every other widget defaults to "-" for an empty value; this one would
    // rather show nothing than claim a level it does not have.
    expect(render("thinking-level", {}, { thinkingLevel: undefined })).toBe("🧠 ");
  });

  it("disappears entirely when told to hide an empty value", () => {
    expect(
      render("thinking-level", { hideWhenEmpty: true }, { thinkingLevel: undefined }),
    ).toBeUndefined();
  });
});

describe("working directory", () => {
  it("shows the directory name without its path", () => {
    expect(render("cwd-basename")).toBe("📂 repo");
  });
});

describe("context widgets", () => {
  it("shows usage as a percentage, trimming a trailing zero", () => {
    expect(render("context", {}, { contextTokens: 100, contextMaxTokens: 1000 })).toBe("🧩 10%");
    expect(render("context", {}, { contextTokens: 125, contextMaxTokens: 1000 })).toBe("🧩 12.5%");
  });

  it("falls back to a raw count when the window size is unknown", () => {
    expect(render("context", {}, { contextTokens: 2500, contextMaxTokens: undefined })).toBe(
      "🧩 2.5k ctx",
    );
  });

  it("shows a question mark when the token count itself is unknown", () => {
    expect(render("context", {}, { contextTokens: undefined })).toBe("🧩 ?");
    expect(render("context-length", {}, { contextTokens: undefined })).toBe("📏 ?");
  });

  it("formats the length in the requested style", () => {
    expect(
      render("context-length", { tokenFormatStyle: "default" }, { contextTokens: 12_345 }),
    ).toBe("📏 12.3k");
    expect(
      render("context-length", { tokenFormatStyle: "compact" }, { contextTokens: 12_345 }),
    ).toBe("📏 12k");
  });

  it("keeps its configured color until the thresholds are switched on", () => {
    const options = { fg: "blue", raw: true, warningFg: "yellow", dangerFg: "red" };
    expect(render("context", options, { contextTokens: 950, contextMaxTokens: 1000 })).toBe("95%");
  });

  it("takes the warning color past the warning threshold", () => {
    const options = {
      raw: true,
      contextConditionalColors: true,
      warningFg: "yellow",
      dangerFg: "red",
    };
    const ctx = { ...baseCtx, colorLevel: "ansi" as const };
    const widget = registry.hydrateWidget(registry.createEntry("context", options));
    expect(
      widget.render(
        contextForDependencies(ctx, registry.spec("context").dependencies, {
          ...statusbarData({ contextTokens: 750, contextMaxTokens: 1000 }),
        }),
      ),
    ).toBe("\x1b[33m75%\x1b[39m");
  });

  it("takes the danger color past the danger threshold", () => {
    const options = {
      raw: true,
      contextConditionalColors: true,
      warningFg: "yellow",
      dangerFg: "red",
    };
    const ctx = { ...baseCtx, colorLevel: "ansi" as const };
    const widget = registry.hydrateWidget(registry.createEntry("context", options));
    expect(
      widget.render(
        contextForDependencies(ctx, registry.spec("context").dependencies, {
          ...statusbarData({ contextTokens: 950, contextMaxTokens: 1000 }),
        }),
      ),
    ).toBe("\x1b[31m95%\x1b[39m");
  });
});

describe("cost", () => {
  it("widens precision below a dollar, where two decimals would round to nothing", () => {
    expect(render("cost", {}, { metrics: { costUsd: 0.0123, firstTimestampMs: undefined } })).toBe(
      "💸 $0.0123",
    );
    expect(render("cost", {}, { metrics: { costUsd: 4.567, firstTimestampMs: undefined } })).toBe(
      "💸 $4.57",
    );
  });

  it("uses three decimals throughout in compact style", () => {
    expect(
      render(
        "cost",
        { costFormatStyle: "compact" },
        {
          metrics: { costUsd: 0.0123, firstTimestampMs: undefined },
        },
      ),
    ).toBe("💸 $0.012");
  });

  it("marks subscription usage only when asked and only when it applies", () => {
    expect(render("cost", { showSubscription: true }, { usingSubscription: true })).toBe(
      "💸 $0.0000 (sub)",
    );
    expect(render("cost", { showSubscription: true }, { usingSubscription: false })).toBe(
      "💸 $0.0000",
    );
    expect(render("cost", { showSubscription: false }, { usingSubscription: true })).toBe(
      "💸 $0.0000",
    );
  });
});

describe("total time", () => {
  it("counts from the first session entry", () => {
    const firstTimestampMs = Date.now() - 90 * 60_000;
    expect(render("total-time", {}, { metrics: { costUsd: 0, firstTimestampMs } })).toBe(
      "⏳ 1h 30m",
    );
  });

  it("shows zero before the session has an entry", () => {
    expect(render("total-time")).toBe("⏳ 0m");
  });
});

describe("git widgets", () => {
  it("shows the branch, bracketed or surrounded on request", () => {
    expect(render("git-branch")).toBe("🌿 main");
    expect(render("git-branch", { gitBranchDisplayStyle: "round-brackets" })).toBe("🌿 (main)");
    expect(
      render("git-branch", {
        gitBranchDisplayStyle: "custom",
        surroundLeft: "[",
        surroundRight: "]",
      }),
    ).toBe("🌿 [main]");
  });

  it("renders an empty branch as the empty placeholder", () => {
    expect(render("git-branch", {}, { git: { branch: null } })).toBe("🌿 ");
    expect(
      render("git-branch", { hideWhenEmpty: true }, { git: { branch: null } }),
    ).toBeUndefined();
  });

  it("shows the short sha", () => {
    expect(render("git-sha")).toBe("🔖 abc1234");
  });

  it("shows staged, unstaged and untracked counts", () => {
    expect(render("git-status", {}, { git: { staged: 2, unstaged: 3, untracked: 1 } })).toBe(
      "🔀 +2 ±3 ?1",
    );
  });

  it("shows the diff plainly or compactly", () => {
    const git = { insertions: 12, deletions: 4 };
    expect(render("git-diff", { gitDiffMode: "plain" }, { git })).toBe("📈 +12/-4");
    expect(render("git-diff", { gitDiffMode: "compact" }, { git })).toBe("📈 (+12,-4)");
  });

  it("shows ahead and behind counts", () => {
    expect(render("git-ahead-behind", {}, { git: { ahead: 2, behind: 1 } })).toBe("↕️ ↑2 ↓1");
  });

  it("goes empty outside a repository, rather than reporting zeros", () => {
    // Zeros would read as a clean repo, which is a different fact from having no
    // repo at all.
    const git = { isRepo: false };
    expect(render("git-status", { hideWhenEmpty: true }, { git })).toBeUndefined();
    expect(render("git-ahead-behind", { hideWhenEmpty: true }, { git })).toBeUndefined();
  });
});

describe("flex separator", () => {
  it("renders nothing, since it only marks where a line splits", () => {
    expect(render("flex-separator")).toBeUndefined();
  });
});

describe("formatting helpers", () => {
  it("formats counts at each magnitude boundary", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1k");
    expect(formatCount(1500)).toBe("1.5k");
    expect(formatCount(1_000_000)).toBe("1m");
  });

  it("matches pi's own token rounding", () => {
    expect(formatPiTokenCount(999)).toBe("999");
    expect(formatPiTokenCount(1500)).toBe("1.5k");
    expect(formatPiTokenCount(12_345)).toBe("12k");
    expect(formatPiTokenCount(1_500_000)).toBe("1.5M");
    expect(formatPiTokenCount(12_500_000)).toBe("13M");
  });

  it("formats elapsed time in hours and minutes", () => {
    const now = 1_000_000_000;
    expect(formatElapsed(now, now)).toBe("0m");
    expect(formatElapsed(now, now + 60_000)).toBe("1m");
    expect(formatElapsed(now, now + 90 * 60_000)).toBe("1h 30m");
    expect(formatElapsed(now, now + 120 * 60_000)).toBe("2h");
    expect(formatElapsed(undefined, now)).toBe("0m");
  });

  it("rounds a sub-minute session up to a minute rather than showing zero", () => {
    const now = 1_000_000_000;
    expect(formatElapsed(now, now + 5_000)).toBe("1m");
  });
});
