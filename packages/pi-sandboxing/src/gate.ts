/**
 * What the gate decides, and what the model is told about it.
 *
 * Nothing here imports Pi. `index.ts` supplies the tool name, the argument and
 * the current rules; this module answers whether to block and supplies the text.
 */
import { relative } from "node:path";
import { isInside, normalizeToolPath, resolveCandidate, resolveLexical } from "./paths.js";
import { gatedArgument, matchesPathPattern, matchRule, type Rule } from "./rules.js";
import type { ProtectedTarget } from "./targets.js";

/** A tool call that wants a gated path, and the rule that caught it. */
export interface GateRequest {
  toolName: string;
  /** The resolved path the tool asked for. */
  target: string;
  /** Workspace-relative, so it matches a needle's origin. */
  origin: string;
  rule: Rule;
}

/**
 * The gate's whole decision for a path argument. `undefined` means the call
 * proceeds untouched, which covers the common cases: an ungated tool, a tool
 * called without a path, and a path no rule claims.
 */
const RECURSIVE_CONTENT_TOOLS = new Set(["grep", "ffgrep", "fff-multi-grep"]);

export function inspectPath(
  toolName: string,
  argument: string | undefined,
  rules: readonly Rule[],
  cwd: string,
  home: string,
  extraTools: ReadonlyMap<string, string>,
  protectedTargets: readonly ProtectedTarget[] = [],
): GateRequest | undefined {
  if (gatedArgument(toolName, extraTools) === undefined) {
    return undefined;
  }
  const recursive = RECURSIVE_CONTENT_TOOLS.has(toolName);
  const input = normalizeToolPath(argument?.trim().replace(/^@/, "") ?? (recursive ? "." : ""));
  if (input === "") {
    return undefined;
  }
  const lexical = resolveLexical(input, cwd, home);
  const target = resolveCandidate(input, cwd, home);
  const alias = protectedTargets.find(
    (protectedTarget) => protectedTarget.path === lexical || protectedTarget.path === target,
  );
  const hasStar = input.includes("*");
  const hasUnsupportedGlob = ["?", "[", "{"].some((marker) => input.includes(marker));
  const descendant = recursive
    ? protectedTargets.find((protectedTarget) => {
        if (protectedTarget.rule === undefined) {
          return false;
        }
        if (hasUnsupportedGlob) {
          return true;
        }
        if (hasStar) {
          return matchesPathPattern(protectedTarget.path, lexical);
        }
        return isInside(lexical, protectedTarget.path) || isInside(target, protectedTarget.path);
      })
    : undefined;
  const rule =
    matchRule(lexical, rules, cwd, home) ??
    matchRule(target, rules, cwd, home) ??
    alias?.rule ??
    descendant?.rule;
  if (rule === undefined) {
    return undefined;
  }
  return { toolName, target, origin: relativeTo(cwd, lexical), rule };
}

function relativeTo(cwd: string, target: string): string {
  return isInside(cwd, target) ? relative(cwd, target) : target;
}

/** What the model is told when a call is refused. Names the fix, not just the refusal. */
export function blockReason(request: GateRequest): string {
  return (
    `Blocked by pi-sandboxing: ${request.target} is protected (matched "${request.rule.glob}"). ` +
    `Protected file tools never expose these paths to the model. Do not retry this path or read it another way.`
  );
}

/** The boundary, as the system prompt states it. */
export function promptNotice(
  rules: readonly Rule[],
  mode: "strict" | "unrestricted-shell",
  backend: string | undefined,
  strictBlockReason?: string,
): string {
  const globs = rules.map((rule) => `- ${rule.glob}`).join("\n");
  let shellLine: string;
  if (mode === "unrestricted-shell") {
    shellLine =
      "Shell commands have full host access because the user enabled unrestricted shell for this session.";
  } else if (strictBlockReason !== undefined) {
    shellLine = `Strict shell commands are blocked: ${strictBlockReason}.`;
  } else if (backend === undefined) {
    shellLine = "Strict shell commands are blocked because no OS sandbox backend is available.";
  } else {
    shellLine = `Shell commands run under the ${backend} backend with protected files, host credentials, and network access denied.`;
  }
  return [
    "\n\n## Secrets (pi-sandboxing)",
    "\nThese paths are protected. File tools cannot read or modify them. Do not retry a blocked path or ask the user to weaken protection. Secret values caught in output are replaced with placeholders such as [redacted: DB_PASS].\n",
    globs,
    `\n${shellLine}`,
    "A value shown as [redacted: NAME] is literal text: writing it into a file writes the placeholder, not the secret.",
  ].join("\n");
}
