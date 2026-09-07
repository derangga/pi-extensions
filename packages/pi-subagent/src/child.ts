import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { runInChildSessionContext } from "./child-context.js";
import type { PiModel, ThinkingLevel } from "./thinking.js";

const FFF_PACKAGE = "@ff-labs/pi-fff";

/** Includes every name fff can register in its default, tools-only and override modes. */
export const CHILD_TOOL_NAMES = [
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

export const SUBAGENT_INSTRUCTIONS = `You are running as a subagent. Your bash tool already executes in the project working directory, so never prefix commands with \`cd\`. You are read-only: inspect the project and report findings, but do not modify it. Return a concise final answer with file and line evidence where useful. Use ask_parent only when truly blocked on information only the parent has, and use notify_parent for a non-blocking update. An unanswered ask times out after ten minutes; then proceed with your best judgment and state your assumption. A task in a later dependency wave is not running yet, so never wait for it.`;

export interface ChildSessionOptions {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly model: PiModel;
  readonly thinking: ThinkingLevel;
  readonly parentSession?: string;
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

export function appendChildPrompt(base: readonly string[], prompt: string): string[] {
  return [...base, [prompt.trim(), SUBAGENT_INSTRUCTIONS].filter(Boolean).join("\n\n")];
}

/** Builds a persisted, read-only child and runs the lifecycle that lazy extensions require. */
export async function createChildSession(
  options: ChildSessionOptions,
): Promise<CreatedChildSession> {
  const fffEntry =
    options.fffEntry === undefined ? resolveFffEntry() : (options.fffEntry ?? undefined);
  const notes: string[] = [];
  if (!fffEntry) notes.push(`${FFF_PACKAGE} is not installed; using Pi's read-only tools only`);

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(fffEntry ? { additionalExtensionPaths: [fffEntry] } : {}),
    appendSystemPromptOverride: (base) => appendChildPrompt(base, options.prompt),
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
      tools: [...CHILD_TOOL_NAMES],
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
