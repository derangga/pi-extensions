import { homedir } from "node:os";
import { join, relative } from "node:path";
import { loadConfig, ruleLayers } from "./config.js";
import { stringField, type JsonObject } from "./json.js";
import { blockReason, inspectPath, promptNotice } from "./gate.js";
import { harvest, harvestFile } from "./harvest.js";
import { buildJail, cleanupJail, pickBackend, type Backend, type Jail } from "./profile.js";
import { isInside, resolveCandidate } from "./paths.js";
import { activeCount, createStore, redact, refreshOrigin } from "./redact.js";
import { gatedArgument, mergeLayers, type Rule } from "./rules.js";
import { wrapCommand } from "./shell.js";
import { discoverProtectedTargets } from "./targets.js";
import {
  type BashToolOptions,
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

type SandboxMode = "strict" | "unrestricted-shell";

const STATUS_KEY = "sandboxing";
const DANGER_PHRASE = "ENABLE UNRESTRICTED SHELL";

function resolveShell(settings: ReturnType<typeof SettingsManager.create>): string {
  return settings.getShellPath() ?? "/bin/bash";
}

export default function sandboxingExtension(pi: ExtensionAPI): void {
  const home = homedir();
  let cwd = process.cwd();
  let mode: SandboxMode = "strict";
  let backend: Backend | undefined;
  let strictBlockReason: string | undefined;
  let rules: Rule[] = [];
  let protectedTargets: ReturnType<typeof discoverProtectedTargets> = [];
  let store = createStore([]);
  let extraTools: ReadonlyMap<string, string> = new Map();
  const announced = new Set<string>();

  function publishStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
    let text: string;
    if (mode === "unrestricted-shell") {
      text = ctx.ui.theme.fg("error", "sandboxing: UNRESTRICTED SHELL");
    } else if (strictBlockReason !== undefined) {
      text = ctx.ui.theme.fg("error", "sandboxing: strict, shell blocked");
    } else if (backend !== undefined) {
      text = ctx.ui.theme.fg("success", `sandboxing: strict (${backend.name})`);
    } else {
      text = ctx.ui.theme.fg("error", "sandboxing: strict, shell blocked");
    }
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  function loadEverything(ctx: ExtensionContext): void {
    cwd = ctx.cwd;
    mode = "strict";
    const loaded = loadConfig(
      getAgentDir(),
      ctx.isProjectTrusted() ? join(cwd, CONFIG_DIR_NAME) : undefined,
    );
    extraTools = loaded.config.gatedTools;
    rules = mergeLayers({ ...ruleLayers(loaded.config), projectTrusted: ctx.isProjectTrusted() });
    store = createStore(harvest(cwd, rules, home, loaded.config.stoplist));
    announced.clear();
    backend = pickBackend(process.platform);
    strictBlockReason = undefined;
    try {
      protectedTargets = discoverProtectedTargets(cwd, rules, home);
    } catch (error) {
      protectedTargets = [];
      strictBlockReason = `protected-path discovery failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (strictBlockReason !== undefined) {
      // Target discovery already supplied the fail-closed reason.
    } else if (!loaded.valid) {
      strictBlockReason = "pi-sandboxing configuration is invalid";
    } else if (backend === undefined) {
      strictBlockReason = "strict mode requires sandbox-exec on macOS or bubblewrap on Linux";
    } else {
      strictBlockReason = undefined;
    }
    if (ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(warning, "warning");
      }
      if (strictBlockReason !== undefined) {
        ctx.ui.notify(
          `pi-sandboxing: ${strictBlockReason}; strict shell commands are blocked.`,
          "warning",
        );
      }
    }
  }

  function prepareJail(commandCwd: string, shellPath: string): Jail {
    if (strictBlockReason !== undefined || backend === undefined) {
      return {
        state: "blocked",
        reason: strictBlockReason ?? "strict shell backend is unavailable",
      };
    }
    let targets;
    try {
      targets = discoverProtectedTargets(cwd, rules, home);
    } catch (error) {
      return {
        state: "blocked",
        reason: `protected-path discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return buildJail(backend, {
      workspace: cwd,
      commandCwd,
      shellPath,
      targets,
      rules,
      home,
      sourceEnvironment: process.env,
    });
  }

  function scrub(text: string, ctx: ExtensionContext): string {
    const result = redact(store, text);
    for (const label of result.labels) {
      if (!announced.has(label)) {
        announced.add(label);
        if (ctx.hasUI) {
          ctx.ui.notify(`pi-sandboxing: redacted ${label}`, "info");
        }
      }
    }
    return result.text;
  }

  function scrubContent(event: ToolResultEvent, ctx: ExtensionContext) {
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") {
        return part;
      }
      const text = scrub(part.text, ctx);
      changed = changed || text !== part.text;
      return { ...part, text };
    });
    return changed ? content : undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    loadEverything(ctx);
    publishStatus(ctx);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + promptNotice(rules, mode, backend?.name, strictBlockReason),
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName === "powershell" && mode === "strict") {
      return {
        block: true,
        reason: "Blocked by pi-sandboxing: strict mode has no PowerShell isolation backend.",
      };
    }
    if (isToolCallEventType("bash", event)) {
      if (mode === "strict" && strictBlockReason !== undefined) {
        return {
          block: true,
          reason: `Blocked by pi-sandboxing: ${strictBlockReason}.`,
        };
      }
      return;
    }
    if (gatedArgument(event.toolName, extraTools) === undefined) {
      return;
    }
    try {
      protectedTargets = discoverProtectedTargets(cwd, rules, home);
    } catch (error) {
      const reason = `protected-path discovery failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        block: true,
        reason: `Blocked by pi-sandboxing: ${reason}.`,
      };
    }
    // SAFETY: Pi tool inputs are JSON objects, and readPathArgument validates the field value.
    const input = event.input as JsonObject;
    const request = inspectPath(
      event.toolName,
      readPathArgument(input, event.toolName, extraTools),
      rules,
      cwd,
      home,
      extraTools,
      protectedTargets,
    );
    return request === undefined ? undefined : { block: true, reason: blockReason(request) };
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      // SAFETY: Pi tool inputs are JSON objects, and stringField validates the path value.
      const input = event.input as JsonObject;
      const argument = stringField(input, "path");
      if (argument !== undefined) {
        const target = resolveCandidate(argument, cwd, home);
        const origin = isInside(cwd, target) ? relative(cwd, target) : target;
        refreshOrigin(store, origin, harvestFile(target, cwd, new Set()));
      }
    }
    const content = scrubContent(event, ctx);
    return content === undefined ? undefined : { content };
  });

  pi.on("user_bash", (event, ctx) => {
    const shellPath = resolveShell(SettingsManager.create(cwd));
    const local = createLocalBashOperations({ shellPath });
    return {
      operations: {
        exec: async (command, commandCwd, options) => {
          const chunks: Buffer[] = [];
          const onData = event.excludeFromContext
            ? options.onData
            : (data: Buffer): void => {
                chunks.push(data);
              };
          const flush = (): void => {
            if (!event.excludeFromContext && chunks.length > 0) {
              options.onData(Buffer.from(scrub(Buffer.concat(chunks).toString("utf8"), ctx)));
            }
          };
          if (mode === "unrestricted-shell") {
            try {
              return await local.exec(command, commandCwd, { ...options, onData });
            } finally {
              flush();
            }
          }
          const jail = prepareJail(commandCwd, shellPath);
          try {
            return await local.exec(wrapCommand(jail, command, shellPath), commandCwd, {
              ...options,
              env: jail.state === "ready" ? jail.env : {},
              onData,
            });
          } finally {
            flush();
            cleanupJail(jail);
          }
        },
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") {
      return {};
    }
    let changed = false;
    const content = event.message.content.map((part) => {
      if (part.type !== "text") {
        return part;
      }
      const text = scrub(part.text, ctx);
      changed = changed || text !== part.text;
      return { ...part, text };
    });
    return changed ? { message: { ...event.message, content } } : {};
  });

  pi.on("session_shutdown", () => {
    store = createStore([]);
    announced.clear();
    mode = "strict";
  });

  registerSandboxedBash(pi, () => mode, prepareJail);

  pi.registerCommand("sandboxing", {
    description: "Inspect or change the shell sandbox mode",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return;
      }
      const choice = await ctx.ui.select("pi-sandboxing", [
        "Show policy details",
        "Use strict shell",
        "Use unrestricted shell",
        "Cancel",
      ]);
      if (choice === "Use strict shell") {
        mode = "strict";
        publishStatus(ctx);
        ctx.ui.notify("Strict shell mode is active.", "info");
        return;
      }
      if (choice === "Use unrestricted shell") {
        const phrase = await ctx.ui.input(
          "Full host access: secrets, sockets, and network become available to shell commands",
          DANGER_PHRASE,
        );
        if (phrase !== DANGER_PHRASE) {
          ctx.ui.notify("Unrestricted shell was not enabled.", "warning");
          return;
        }
        mode = "unrestricted-shell";
        publishStatus(ctx);
        ctx.ui.notify(
          "Unrestricted shell is active for this session. Protected file tools and redaction remain active.",
          "warning",
        );
        return;
      }
      if (choice === "Show policy details") {
        const lines = [
          `Shell mode: ${mode}.`,
          backend === undefined ? "OS backend: unavailable." : `OS backend: ${backend.name}.`,
          `Needles: ${activeCount(store)} loaded, ${announced.size} redacted.`,
          "Rules:",
          ...rules.map((rule) => `  ${rule.glob}  (${rule.source})`),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });
}

function registerSandboxedBash(
  pi: ExtensionAPI,
  currentMode: () => SandboxMode,
  prepareJail: (cwd: string, shellPath: string) => Jail,
): void {
  const settings = SettingsManager.create(process.cwd());
  const shellPath = resolveShell(settings);
  const local = createLocalBashOperations({ shellPath });
  const operations: NonNullable<BashToolOptions["operations"]> = {
    exec: async (command, cwd, options) => {
      if (currentMode() === "unrestricted-shell") {
        return local.exec(command, cwd, options);
      }
      const jail = prepareJail(cwd, shellPath);
      try {
        return await local.exec(wrapCommand(jail, command, shellPath), cwd, {
          ...options,
          env: jail.state === "ready" ? jail.env : {},
        });
      } finally {
        cleanupJail(jail);
      }
    },
  };
  const options: BashToolOptions = {
    shellPath,
    operations,
    exposeSessionEnvironment: false,
  };
  const commandPrefix = settings.getShellCommandPrefix();
  if (commandPrefix !== undefined) {
    options.commandPrefix = commandPrefix;
  }
  const definition = createBashToolDefinition(process.cwd(), options);
  pi.registerTool({ ...definition, label: "bash (sandboxed)" });
}

function readPathArgument(
  input: JsonObject,
  toolName: string,
  extraTools: ReadonlyMap<string, string>,
): string | undefined {
  return stringField(input, gatedArgument(toolName, extraTools) ?? "path");
}
