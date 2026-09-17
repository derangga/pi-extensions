/**
 * Which tool calls the boundary inspects, and what it decides about them.
 *
 * Pi resolves any absolute path its file tools are handed, so the gate is the
 * only thing that makes a directory boundary exist at all. It works by name:
 * a tool is gated when this table (or the user's `gatedTools` config) says
 * which of its arguments holds a path.
 */
import { grantScopes, isAllowed, resolveCandidate, type GrantScopes } from "./boundary.js";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Tool name to the argument that names a path.
 *
 * The first six are Pi's built-ins. The last three are `@ff-labs/pi-fff`,
 * whose `path` argument documents itself as accepting absolute, `~/` and `../`
 * paths outside the workspace, searched through a separate index — a way out
 * of the workspace that looks nothing like a file read. fff renames its tools
 * to `grep`, `find` and `multi_grep` in override mode, which this table
 * already covers, so no mode detection is needed. `fff-multi-grep` has no path
 * argument today; listing it costs one line and covers the day it gains one.
 */
const GATED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["read", "path"],
  ["edit", "path"],
  ["write", "path"],
  ["ls", "path"],
  ["grep", "path"],
  ["find", "path"],
  ["ffgrep", "path"],
  ["fffind", "path"],
  ["fff-multi-grep", "path"],
]);

/** A tool call that wants out of the boundary, and the grants that would let it. */
export interface GateRequest {
  toolName: string;
  /** The resolved path the tool asked for. */
  target: string;
  scopes: GrantScopes;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Read one named argument off a tool call. Tool arguments arrive as JSON from
 * the model, and the field to read is only known at runtime, so this walks the
 * entries rather than indexing a type that has no index signature.
 */
function readArgument(event: ToolCallEvent, field: string): string | undefined {
  for (const [key, value] of Object.entries(event.input)) {
    if (key === field && isString(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * The gate's whole decision. `undefined` means the call proceeds untouched,
 * which covers the common cases: an ungated tool, a tool called without a
 * path, a repo-relative argument, and a path already inside the boundary.
 */
export function inspectToolCall(
  event: ToolCallEvent,
  cwd: string,
  allowedRoots: readonly string[],
  home: string,
  extraTools: ReadonlyMap<string, string>,
): GateRequest | undefined {
  const field = extraTools.get(event.toolName) ?? GATED_TOOLS.get(event.toolName);
  if (field === undefined) {
    return undefined;
  }
  const argument = readArgument(event, field);
  if (argument === undefined || argument.trim() === "") {
    return undefined;
  }
  // Resolved without asking what the value looks like. fff's `path` is a
  // constraint as often as a path — `src/**` and `main.rs` are legal — and
  // those resolve to somewhere inside the workspace, which is the answer the
  // gate wants anyway. Deciding syntactically instead would let a symlink
  // inside the workspace walk out through a path that never spells `..`.
  const target = resolveCandidate(argument.trim(), cwd);
  if (isAllowed(allowedRoots, target)) {
    return undefined;
  }
  return { toolName: event.toolName, target, scopes: grantScopes(target, home) };
}

/** What the model is told when a call is refused. Names the fix, not just the refusal. */
export function blockReason(request: GateRequest, interactive: boolean): string {
  const head = `Blocked by pi-dir-permission: ${request.target} is outside this session's allowed directories.`;
  return interactive
    ? `${head} The user declined access. Do not retry this path; ask them what to do instead.`
    : `${head} No one can be asked in this run — the user grants access with /dir-perm-add <path> from an interactive session.`;
}

/** The boundary, as the system prompt states it. */
export function boundaryNotice(allowedRoots: readonly string[]): string {
  const roots = allowedRoots.map((root) => `- ${root}`).join("\n");
  return [
    "\n\n## Directory permissions (pi-dir-permission)",
    "\nFile tools are confined to these directories. A path outside them is blocked until the user grants it, which interrupts them with a dialog — so prefer paths inside these roots, and ask before reaching outside.\n",
    roots,
    "\nThe shell is not confined by this boundary, but the same courtesy applies.",
  ].join("\n");
}
