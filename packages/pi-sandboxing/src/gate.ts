/**
 * What the gate decides, and what the model is told about it.
 *
 * Nothing here imports Pi. `index.ts` supplies the tool name, the argument and
 * the current rules; this module answers whether to ask, and supplies the text.
 */
import { resolveCandidate } from "./paths.js";
import { gatedArgument, matchRule, type Rule } from "./rules.js";

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
export function inspectPath(
  toolName: string,
  argument: string | undefined,
  rules: readonly Rule[],
  cwd: string,
  home: string,
  extraTools: ReadonlyMap<string, string>,
): GateRequest | undefined {
  if (gatedArgument(toolName, extraTools) === undefined) {
    return undefined;
  }
  if (argument === undefined || argument.trim() === "") {
    return undefined;
  }
  const target = resolveCandidate(argument.trim(), cwd, home);
  const rule = matchRule(target, rules, cwd, home);
  if (rule === undefined) {
    return undefined;
  }
  return { toolName, target, origin: relativeTo(cwd, target), rule };
}

function relativeTo(cwd: string, target: string): string {
  return target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target;
}

/**
 * Tokens of a shell command that a rule claims. The split breaks on shell
 * punctuation as well as whitespace, so a path inside `$(...)` is still seen.
 * Splitting on `=` as well catches `SECRET=.env`. Best effort by construction:
 * a variable whose value was set in an earlier command (`cat $SECRET`) is not a
 * path here and never will be, which is why the redactor exists.
 */
export function scanCommand(
  command: string,
  rules: readonly Rule[],
  cwd: string,
  home: string,
): GateRequest | undefined {
  for (const raw of command.split(/[\s;|&()<>=]+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (token === "" || token.startsWith("-")) {
      continue;
    }
    // Only tokens that look like a path or a filename, so a rule like `.env`
    // cannot be triggered by a word in a commit message.
    if (!token.includes("/") && !token.includes(".")) {
      continue;
    }
    const target = resolveCandidate(token, cwd, home);
    const rule = matchRule(target, rules, cwd, home);
    if (rule !== undefined) {
      return { toolName: "bash", target, origin: relativeTo(cwd, target), rule };
    }
  }
  return undefined;
}

/** What the model is told when a call is refused. Names the fix, not just the refusal. */
export function blockReason(request: GateRequest): string {
  return (
    `Blocked by pi-sandboxing: ${request.target} is a secret file (matched "${request.rule.glob}") ` +
    `and the user declined access. Do not retry this path or read it another way; ` +
    `ask the user for what you need from it.`
  );
}

/** The dialog title. Names the file and the rule that caught it. */
export function promptTitle(request: GateRequest): string {
  return `${request.toolName} wants ${request.target}, a secret file (matched "${request.rule.glob}")`;
}

/** The boundary, as the system prompt states it. */
export function promptNotice(rules: readonly Rule[], jailed: boolean): string {
  const globs = rules.map((rule) => `- ${rule.glob}`).join("\n");
  const jailLine = jailed
    ? "Credential directories in the user's home are denied to the shell by the operating system, so a command that reads one fails outright."
    : "No OS-level jail is active on this machine, so the shell can still reach these paths.";
  return [
    "\n\n## Secrets (pi-sandboxing)",
    "\nThese paths are gated. Touching one interrupts the user with a dialog, and any secret value read from them is replaced with a placeholder like [redacted: DB_PASS] in your tool output. Ask the user for what you need rather than reading them.\n",
    globs,
    `\n${jailLine}`,
    "A value shown as [redacted: NAME] is literal text: writing it into a file writes the placeholder, not the secret.",
  ].join("\n");
}
