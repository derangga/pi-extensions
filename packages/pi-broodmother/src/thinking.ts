import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi's thinking level, taken from the extension surface rather than imported.
 *
 * Two packages export a type called `ThinkingLevel` and they are not the same:
 * pi-agent-core's includes `"off"`, pi-ai's does not and calls the wider one
 * `ModelThinkingLevel`. `ExtensionContext` carries the pi-agent-core one, so
 * deriving from it here picks the right of the two by construction.
 */
export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

/** The model shape Pi hands out, derived so nothing here imports pi-ai. */
export type PiModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

/** Every level Pi knows, weakest first. Mirrors pi-ai's EXTENDED_THINKING_LEVELS. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

/**
 * What a model will actually accept.
 *
 * This reimplements pi-ai's `getSupportedThinkingLevels` because that function
 * is not reachable: it lives in `@earendil-works/pi-ai/compat`, which Pi keeps
 * as a nested shrinkwrapped dependency and never re-exports. The public route
 * is `AgentSession.getAvailableThinkingLevels()`, which needs a session, and
 * the settings menu has to answer this question before any session exists.
 *
 * The rule is asymmetric, which is the part worth stating: a missing key in
 * `thinkingLevelMap` means "use the provider default", so `minimal` through
 * `high` are opt-out. `xhigh` and `max` are opt-in, and a missing key excludes
 * them. An explicit null excludes any level. A model with `reasoning: false`
 * collapses to `off` no matter what the map says.
 */
export function supportedThinkingLevels(model: PiModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
