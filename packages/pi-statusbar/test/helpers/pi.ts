import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { taggedTheme } from "./theme.js";

/**
 * Stubs for the Pi surface the extension entry touches. Each carries only the
 * methods the entry actually calls, cast at the boundary, so a test never has to
 * build a whole agent to watch one repaint happen.
 */

export interface ContextStub {
  ctx: ExtensionContext;
  footers: (FooterFactory | undefined)[];
  statuses: (string | undefined)[];
  notifications: { message: string; type: string | undefined }[];
  /** Every picker the code opened, in order, with the rows it offered. */
  selects: { title: string; options: string[] }[];
}

export type FooterFactory = (
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
) => { render(width: number): string[]; invalidate(): void; dispose?(): void };

export interface ContextOptions {
  hasUI?: boolean;
  cwd?: string;
  model?: { id: string; provider: string; reasoning?: boolean } | undefined;
  usingOAuth?: boolean;
  contextUsage?: { tokens: number | null; contextWindow: number } | undefined;
  entries?: readonly unknown[];
  theme?: Theme;
  /** One answer per ui.select call, in order. Undefined is a cancel. */
  selections?: readonly (string | undefined)[];
}

export function stubContext(options: ContextOptions = {}): ContextStub {
  const footers: (FooterFactory | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: { message: string; type: string | undefined }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  const answers = [...(options.selections ?? [])];

  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? "/repo",
    // Naming the key at all, even as undefined, means the test wants no model.
    model:
      "model" in options ? options.model : { id: "opus", provider: "anthropic", reasoning: true },
    modelRegistry: { isUsingOAuth: () => options.usingOAuth ?? false },
    sessionManager: { getBranch: () => [...(options.entries ?? [])] },
    getContextUsage: () =>
      "contextUsage" in options ? options.contextUsage : { tokens: 100, contextWindow: 1000 },
    ui: {
      theme: options.theme ?? taggedTheme,
      setFooter: (factory: FooterFactory | undefined) => footers.push(factory),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      select: (title: string, choices: string[]) => {
        selects.push({ title, options: choices });
        // Running past the script is a cancel, not a hang: a test that opens
        // one more picker than it scripted should fail on the commit it did
        // not make rather than on a timeout.
        return Promise.resolve(answers.shift());
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, footers, statuses, notifications, selects };
}

export interface CommandStub {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export interface ApiStub {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  commands: Map<string, CommandStub>;
  execCalls: string[];
  fire(event: string, ctx: ExtensionContext, payload?: unknown): Promise<void>;
  run(command: string, args: string, ctx: ExtensionContext): Promise<void>;
}

export function stubApi(
  output: Record<string, string> = { "rev-parse --show-toplevel": "/repo" },
  thinkingLevel = "high",
): ApiStub {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, CommandStub>();
  const execCalls: string[] = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: CommandStub) => {
      commands.set(name, options);
    },
    getThinkingLevel: () => thinkingLevel,
    exec: async (_command: string, args: string[]) => {
      const key = args.join(" ");
      execCalls.push(key);
      const stdout = output[key];
      return stdout === undefined
        ? { stdout: "", stderr: "fatal", code: 128, killed: false }
        : { stdout: `${stdout}\n`, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    handlers,
    commands,
    execCalls,
    async fire(event, ctx, payload) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      await handler(payload ?? { type: event }, ctx);
    },
    async run(command, args, ctx) {
      const registered = commands.get(command);
      if (!registered) throw new Error(`no command registered as ${command}`);
      await registered.handler(args, ctx as ExtensionCommandContext);
    },
  };
}

export interface FooterDataStub {
  footerData: ReadonlyFooterDataProvider;
  branchListeners: (() => void)[];
  unsubscribeCount: number;
  changeBranch(): void;
}

export function stubFooterData(
  branch: string | null = "main",
  statuses: ReadonlyMap<string, string> = new Map(),
): FooterDataStub {
  const branchListeners: (() => void)[] = [];
  const stub: FooterDataStub = {
    branchListeners,
    unsubscribeCount: 0,
    changeBranch: () => {
      for (const listener of branchListeners.slice()) listener();
    },
    footerData: {
      getGitBranch: () => branch,
      getExtensionStatuses: () => statuses,
      onBranchChange: (listener: () => void) => {
        branchListeners.push(listener);
        return () => {
          stub.unsubscribeCount += 1;
          const index = branchListeners.indexOf(listener);
          if (index >= 0) branchListeners.splice(index, 1);
        };
      },
    } as unknown as ReadonlyFooterDataProvider,
  };
  return stub;
}

export interface TuiStub {
  tui: TUI;
  renderRequests: number;
}

export function stubTui(): TuiStub {
  const stub: TuiStub = {
    renderRequests: 0,
    tui: {
      requestRender: () => {
        stub.renderRequests += 1;
      },
    } as unknown as TUI,
  };
  return stub;
}
