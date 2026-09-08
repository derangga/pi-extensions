import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { runInChildSessionContext } from "./child-context.js";
import type { Permissions } from "./settings.js";
import type { PiModel, ThinkingLevel } from "./thinking.js";

const FFF_PACKAGE = "@ff-labs/pi-fff";

/** Includes every name fff can register in its default, tools-only and override modes. */
export const CHILD_TOOL_NAMES_READONLY = [
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
  "fff-multi-grep",
  "multi_grep",
  "ask_parent",
  "notify_parent",
] as const;

/**
 * What `read-write` adds. No `powershell`: Pi's own default active set is
 * read, bash, edit and write with no platform branch, so a child is handed the
 * same shell the parent got rather than one this package guessed at.
 */
export const CHILD_TOOL_NAMES_READWRITE = [
  ...CHILD_TOOL_NAMES_READONLY,
  "edit",
  "write",
  "bash",
] as const;

/** The read-only list under its old name, for callers that predate the split. */
export const CHILD_TOOL_NAMES = CHILD_TOOL_NAMES_READONLY;

/**
 * The half of the child's instructions that does not depend on what it may do.
 * Extracted so the two permission variants cannot drift apart on the parts
 * that have nothing to do with permissions.
 */
const SUBAGENT_COMMON = `Return a concise final answer with file and line evidence where useful. Use ask_parent only when truly blocked on information only the parent has, and use notify_parent for a non-blocking update. An unanswered ask times out after ten minutes; then proceed with your best judgment and state your assumption. A task in a later dependency wave is not running yet, so never wait for it.`;

export const SUBAGENT_INSTRUCTIONS_READONLY = `You are running as a subagent. You are read-only: you can read, search and list files, and you have no tool that edits, writes or runs a command. Inspect the project and report findings. ${SUBAGENT_COMMON}`;

export const SUBAGENT_INSTRUCTIONS_READWRITE = `You are running as a subagent with write access: you can read, search and list files, and you can edit, write and run commands when the task calls for it. Nothing confines you to the project directory and nothing asks the user before a change lands, so make the smallest change the task needs and say what you changed, with paths. ${SUBAGENT_COMMON}`;

/** The read-only text under its old name, for callers that predate the split. */
export const SUBAGENT_INSTRUCTIONS = SUBAGENT_INSTRUCTIONS_READONLY;

export function childInstructions(permissions: Permissions): string {
  return permissions === "read-write"
    ? SUBAGENT_INSTRUCTIONS_READWRITE
    : SUBAGENT_INSTRUCTIONS_READONLY;
}

export function childToolNames(permissions: Permissions): readonly string[] {
  return permissions === "read-write" ? CHILD_TOOL_NAMES_READWRITE : CHILD_TOOL_NAMES_READONLY;
}

export interface ChildSessionOptions {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly model: PiModel;
  readonly thinking: ThinkingLevel;
  /**
   * The ceiling on what this child may do. Required rather than defaulted, so
   * the compiler makes every spawn path name it and a dropped thread cannot
   * quietly pin every child to one mode.
   */
  readonly permissions: Permissions;
  readonly parentSession?: string;
  /**
   * The parent's answer to the project trust prompt. A child builds its own
   * SettingsManager, whose `projectTrusted` defaults to true, so without this
   * a child would read a repo's own `.agents/skills` in a project the user
   * declined to trust. Required rather than defaulted: a trust decision is
   * the caller's to state.
   */
  readonly projectTrusted: boolean;
  /** Test/custom-session seam. Production callers normally leave this undefined. */
  readonly sessionDir?: string;
  readonly modelRuntime?: ModelRuntime;
  readonly customTools?: ToolDefinition[];
  /** Test seam. Omit to resolve the installed fff package. Null disables fff. */
  readonly fffEntry?: string | null;
}

export interface CreatedChildSession {
  readonly session: AgentSession;
  readonly sessionFile: string | undefined;
  readonly fffLoaded: boolean;
  readonly notes: readonly string[];
}

type ShutdownSession = Pick<AgentSession, "dispose" | "extensionRunner">;

/** Closes the extension lifecycle opened by bindExtensions before invalidating it. */
export async function shutdownChildSession(
  session: ShutdownSession,
  timeoutMs = 3_000,
): Promise<void> {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        void session.extensionRunner
          .emit({ type: "session_shutdown", reason: "quit" })
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(timeout);
            resolve();
          });
      });
    }
  } catch {
    // A broken shutdown handler must not prevent the session from being invalidated.
  } finally {
    session.dispose();
  }
}

export function resolveFffEntry(
  resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): string | undefined {
  try {
    const resolved = resolve(FFF_PACKAGE);
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  } catch {
    return undefined;
  }
}

export function appendChildPrompt(
  base: readonly string[],
  prompt: string,
  permissions: Permissions = "read-only",
): string[] {
  return [...base, [prompt.trim(), childInstructions(permissions)].filter(Boolean).join("\n\n")];
}

/** Builds a persisted child and runs the lifecycle that lazy extensions require. */
export async function createChildSession(
  options: ChildSessionOptions,
): Promise<CreatedChildSession> {
  const fffEntry =
    options.fffEntry === undefined ? resolveFffEntry() : (options.fffEntry ?? undefined);
  const notes: string[] = [];
  if (!fffEntry) {
    notes.push(`${FFF_PACKAGE} is not installed; using Pi's built-in tools only`);
  }

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(options.cwd, getAgentDir(), {
      projectTrusted: options.projectTrusted,
    }),
    noExtensions: true,
    // Skills stay on. A skill is not a capability: Pi injects a name, a
    // description and a path, and the model opens the body with `read`, which
    // every child already has. Discovery is the package manager's, so this
    // reaches `~/.agents/skills` and `.agents/skills` up to the git root,
    // exactly what the parent sees. Project skills are trust-gated above.
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(fffEntry ? { additionalExtensionPaths: [fffEntry] } : {}),
    appendSystemPromptOverride: (base) =>
      appendChildPrompt(base, options.prompt, options.permissions),
  });
  await runInChildSessionContext(() => loader.reload());

  for (const error of loader.getExtensions().errors) {
    notes.push(`could not load child extension ${error.path}: ${error.error}`);
  }

  const sessionManager = SessionManager.create(
    options.cwd,
    options.sessionDir,
    options.parentSession ? { parentSession: options.parentSession } : undefined,
  );
  const created = await runInChildSessionContext(() =>
    createAgentSession({
      cwd: options.cwd,
      agentDir: getAgentDir(),
      resourceLoader: loader,
      sessionManager,
      model: options.model,
      thinkingLevel: options.thinking,
      tools: [...childToolNames(options.permissions)],
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(options.customTools ? { customTools: options.customTools } : {}),
    }),
  );

  try {
    created.session.setSessionName(`subagent: ${options.name}`);
    await created.session.bindExtensions({
      onError: (error) => notes.push(`child extension failed: ${error.extensionPath}`),
    });
  } catch (cause) {
    await shutdownChildSession(created.session);
    throw cause;
  }

  if (created.session.thinkingLevel !== options.thinking) {
    notes.push(
      `thinking "${options.thinking}" was adjusted by Pi to "${created.session.thinkingLevel}"`,
    );
  }

  return {
    session: created.session,
    sessionFile: created.session.sessionFile,
    fffLoaded: fffEntry !== undefined && loader.getExtensions().errors.length === 0,
    notes,
  };
}
