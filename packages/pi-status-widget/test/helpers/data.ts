import type { GitInfo, SessionMetrics, StatusbarData } from "../../src/types.js";
import type { BaseWidgetContext } from "../../src/widgets/types.js";

export const baseCtx: BaseWidgetContext = { iconMode: "emoji", colorLevel: "none" };

const CLEAN_REPO: GitInfo = {
  branch: "main",
  sha: "abc1234",
  staged: 0,
  unstaged: 0,
  untracked: 0,
  insertions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  isRepo: true,
};

/**
 * A render snapshot with sane defaults. git and metrics merge field by field, so
 * a test naming one git count keeps isRepo and the rest, rather than silently
 * replacing the whole object.
 */
export type DataOverrides = Partial<Omit<StatusbarData, "git" | "metrics">> & {
  git?: Partial<GitInfo>;
  metrics?: Partial<SessionMetrics>;
};

export function statusbarData(overrides: DataOverrides = {}): StatusbarData {
  return {
    model: "opus",
    provider: "anthropic",
    thinkingLevel: "high",
    cwd: "/home/dev/repo",
    usingSubscription: false,
    contextTokens: 100,
    contextMaxTokens: 1000,
    ...overrides,
    git: { ...CLEAN_REPO, ...overrides.git },
    metrics: { costUsd: 0, firstTimestampMs: undefined, ...overrides.metrics },
  };
}
