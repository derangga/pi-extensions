import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/**
 * A stand-in for Pi, built rather than borrowed: the upstream package's test
 * utilities are exactly the coupling this fork exists to remove.
 *
 * It records what the extension registers and lets a test drive the tool's
 * `execute` directly, which is the only way to see the routing decisions --
 * which host path is taken, which envelope comes back -- from outside.
 */

export interface CapturedTool {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

export interface MockPi {
  pi: ExtensionAPI;
  tools: Map<string, CapturedTool>;
  events: { channel: string; payload: unknown }[];
  handlers: Map<string, ((event: unknown, ctx: ExtensionContext) => void)[]>;
  activeTools: string[];
  setActiveTools: ReturnType<typeof vi.fn>;
  /** Fire a lifecycle event at whatever the extension registered for it. */
  fire(name: string, ctx: ExtensionContext): void;
}

export function createMockPi(initialTools: string[] = []): MockPi {
  const tools = new Map<string, CapturedTool>();
  const events: { channel: string; payload: unknown }[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void)[]>();
  const state = { activeTools: [...initialTools] };
  const setActiveTools = vi.fn<(names: string[]) => void>((names) => {
    state.activeTools = [...names];
  });

  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool as unknown as CapturedTool);
      if (!state.activeTools.includes(tool.name)) state.activeTools.push(tool.name);
    },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        events.push({ channel, payload });
      },
    },
    getActiveTools: () => [...state.activeTools],
    setActiveTools,
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    events,
    handlers,
    get activeTools() {
      return state.activeTools;
    },
    setActiveTools,
    fire(name, ctx) {
      for (const handler of handlers.get(name) ?? []) handler({}, ctx);
    },
  };
}

export interface MockCtxOptions {
  hasUI?: boolean;
  mode?: string;
  cwd?: string;
  projectTrusted?: boolean;
  /** Omit to leave the host without the dialog primitives entirely. */
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  /** Omit to leave the host without `custom`, i.e. no overlay rendering. */
  custom?: (factory: unknown, options: unknown) => Promise<unknown>;
  onTerminalInput?: (handler: (data: string) => unknown) => () => void;
}

export interface MockCtx {
  ctx: ExtensionContext;
  notices: { message: string; level?: string | undefined }[];
}

export function createMockCtx(options: MockCtxOptions = {}): MockCtx {
  const notices: { message: string; level?: string | undefined }[] = [];
  const ui: Record<string, unknown> = {
    notify: (message: string, level?: string) => notices.push({ message, level }),
  };
  if (options.select) ui.select = options.select;
  if (options.input) ui.input = options.input;
  if (options.custom) ui.custom = options.custom;
  if (options.onTerminalInput) ui.onTerminalInput = options.onTerminalInput;

  const ctx = {
    hasUI: options.hasUI ?? true,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    cwd: options.cwd ?? "/workspace",
    isProjectTrusted: () => options.projectTrusted ?? false,
    ui,
  } as unknown as ExtensionContext;

  return { ctx, notices };
}
