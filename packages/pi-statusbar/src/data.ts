import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { EMPTY_GIT_INFO, getGitInfo, type GitCommand } from "./git.js";
import { collectSessionMetrics } from "./metrics.js";
import type { StatusbarData } from "./types.js";

export interface StatusbarSources {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  /** The branch Pi already tracks by watching the ref, so nothing shells out for it. */
  branchHint: string | null;
  /** Undefined when no git widget is enabled, which skips git collection entirely. */
  gitCommands: ReadonlySet<GitCommand> | undefined;
  requestRender: () => void;
}

/**
 * The snapshot one draw reads, assembled from Pi's context. Every value is read
 * fresh: the footer holds no derived state between draws, so nothing here can
 * go stale except the git snapshot, which is stale by design.
 */
export function collectStatusbarData({
  ctx,
  pi,
  branchHint,
  gitCommands,
  requestRender,
}: StatusbarSources): StatusbarData {
  const contextUsage = ctx.getContextUsage();
  return {
    model: ctx.model?.id,
    provider: ctx.model?.provider,
    // Asking a model that does not reason for its thinking level returns Pi's
    // default rather than nothing, which would paint a level the model will
    // never use.
    thinkingLevel: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
    git: gitCommands
      ? getGitInfo(pi, ctx.cwd, branchHint, gitCommands, requestRender)
      : EMPTY_GIT_INFO,
    cwd: ctx.cwd,
    usingSubscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
    // tokens is null in the window between a compaction and the next response.
    // The context widgets treat that as unknown rather than as zero.
    contextTokens: contextUsage?.tokens ?? undefined,
    contextMaxTokens: contextUsage?.contextWindow,
    metrics: collectSessionMetrics(ctx.sessionManager.getBranch()),
  };
}
