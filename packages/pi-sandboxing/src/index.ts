/**
 * pi-sandboxing — Pi extension. One deny list, enforced in three places.
 *
 * Pi ships no sandbox: the file tools resolve whatever absolute path they are
 * handed, and bash runs unwrapped. So the rules are enforced three times over,
 * because no single place can cover the others:
 *
 * - The kernel profile denies the user's home credential directories to every
 *   bash subprocess. It cannot reach Pi's own tools, which run in this process.
 * - The gate asks before a file tool touches a rule-matching path. It cannot
 *   see inside a shell command.
 * - The redactor replaces harvested values in everything leaving a tool. It
 *   cannot catch a value it never harvested.
 *
 * The gate and the redactor meet through one set of strings: approving a read
 * burns that file's needles before the tool runs, so the redactor reaches the
 * approved result and finds nothing left to replace. No call bookkeeping.
 *
 * Zero runtime dependencies: the host provides everything
 * (@earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox) as peers.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ruleLayers, type SandboxingConfig } from "./config.js";
import { stringField, type JsonObject } from "./json.js";
import { blockReason, inspectPath, promptNotice, promptTitle, scanCommand } from "./gate.js";
import { harvest, harvestFile } from "./harvest.js";
import { buildJail, denyTargets, pickBackend, type Jail } from "./profile.js";
import { isDirectory, resolveCandidate } from "./paths.js";
import { activeCount, burnOrigin, createStore, redact, refreshOrigin } from "./redact.js";
import { homeRules, mergeLayers, type Rule } from "./rules.js";
import { wrapCommand } from "./shell.js";
import {
  type BashSpawnContext,
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

/** Whatever shell the host would have used, and something sane if it says nothing. */
function resolveShell(settings: ReturnType<typeof SettingsManager.create>): string {
  return settings.getShellPath() ?? process.env["SHELL"] ?? "/bin/sh";
}

const STATUS_KEY = "sandboxing";

export default function sandboxingExtension(pi: ExtensionAPI): void {
  const home = homedir();
  let cwd = process.cwd();
  let rules: Rule[] = [];
  let store = createStore([]);
  let jail: Jail | undefined;
  let enabled = true;
  let extraTools: ReadonlyMap<string, string> = new Map();
  /** Labels already announced, so a loop that hits one forty times says it once. */
  const announced = new Set<string>();
  let burnedCount = 0;

  function publishStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!("ui" in ctx) || !("setStatus" in ctx.ui)) {
      return;
    }
    const jailMark = jail === undefined ? " (no OS jail)" : "";
    const burned = burnedCount === 0 ? "" : `, ${burnedCount} burned`;
    ctx.ui.setStatus(
      STATUS_KEY,
      `secrets ${announced.size}/${activeCount(store)}${burned}${jailMark}`,
    );
  }

  function loadEverything(ctx: ExtensionContext): SandboxingConfig {
    cwd = ctx.cwd;
    // The workspace layer is read only for a trusted checkout: an untrusted one
    // must not be able to shrink its own deny list.
    const loaded = loadConfig(
      getAgentDir(),
      ctx.isProjectTrusted() ? join(cwd, CONFIG_DIR_NAME) : undefined,
    );
    enabled = loaded.config.enabled;
    extraTools = loaded.config.gatedTools;
    rules = mergeLayers({ ...ruleLayers(loaded.config), projectTrusted: ctx.isProjectTrusted() });
    store = createStore(harvest(cwd, rules, home, loaded.config.stoplist));
    announced.clear();
    burnedCount = 0;
    jail = buildJail(
      pickBackend(process.platform, existsSync),
      denyTargets(homeRules(rules, home), home, isDirectory),
    );
    if (ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(warning, "warning");
      }
      if (jail === undefined && enabled) {
        ctx.ui.notify(
          "pi-sandboxing: no OS-level jail on this platform, so the shell is not confined. The gate and redaction are still active.",
          "warning",
        );
      }
    }
    return loaded.config;
  }

  /** Redact, count, and announce each value the first time it is caught. */
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
    if (result.labels.length > 0) {
      publishStatus(ctx);
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

  /** Ask, and burn the file's needles when the user says yes. */
  async function ask(
    request: ReturnType<typeof inspectPath>,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (request === undefined) {
      return true;
    }
    const allow = "Allow once, this call only";
    const choice = await ctx.ui.select(promptTitle(request), [allow, "Deny"]);
    if (choice !== allow) {
      return false;
    }
    // Burn before the tool runs, so the redactor leaves the approved result
    // alone without either half knowing about the other.
    const burned = burnOrigin(store, request.origin);
    burnedCount += burned.length;
    publishStatus(ctx);
    return true;
  }

  pi.on("session_start", (_event, ctx) => {
    loadEverything(ctx);
    publishStatus(ctx);
  });

  pi.on("before_agent_start", (event) =>
    enabled ? { systemPrompt: event.systemPrompt + promptNotice(rules, jail !== undefined) } : {},
  );

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) {
      return;
    }
    const request = isToolCallEventType("bash", event)
      ? scanCommand(event.input.command, rules, cwd, home)
      : inspectPath(
          event.toolName,
          // SAFETY: tool input arrives as JSON from the model, so JsonObject is
          // exactly its shape, and every field is guarded before use.
          readPathArgument(event.input as JsonObject, event.toolName, extraTools),
          rules,
          cwd,
          home,
          extraTools,
        );
    if (request === undefined) {
      return;
    }
    // Headless allows the call: there is nobody to interrupt, and the redactor
    // still keeps the values out of the model's context.
    if (!ctx.hasUI) {
      return;
    }
    return (await ask(request, ctx)) ? undefined : { block: true, reason: blockReason(request) };
  });

  pi.on("tool_result", (event, ctx) => {
    if (!enabled) {
      return;
    }
    // A write or an edit changed the file, so its needles are stale.
    if (event.toolName === "write" || event.toolName === "edit") {
      // SAFETY: tool input arrives as JSON from the model, so JsonObject is
      // exactly its shape, and the field is guarded before use.
      const argument = stringField(event.input as JsonObject, "path");
      if (argument !== undefined) {
        const target = resolveCandidate(argument, cwd, home);
        const origin = target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target;
        refreshOrigin(store, origin, harvestFile(target, cwd, new Set()));
      }
    }
    const content = scrubContent(event, ctx);
    return content === undefined ? undefined : { content };
  });

  pi.on("user_bash", (event, ctx) => {
    if (!enabled) {
      return;
    }
    const local = createLocalBashOperations();
    const shellPath = resolveShell(SettingsManager.create(cwd));
    return {
      operations: {
        exec: (command, commandCwd, options) =>
          local.exec(wrapCommand(jail, command, shellPath), commandCwd, {
            ...options,
            // A `!!` command never reaches the model, so redacting it would
            // only hide the file from the person who asked to see it.
            onData: (data) =>
              options.onData(
                event.excludeFromContext ? data : Buffer.from(scrub(data.toString("utf8"), ctx)),
              ),
          }),
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    // Only the assistant's own words. A user message is the user's typing,
    // which is never redacted, and a tool result was handled on its own hook.
    if (!enabled || event.message.role !== "assistant") {
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
    // SAFETY: the role and every non-text part are carried through untouched.
    return changed ? { message: { ...event.message, content } } : {};
  });

  pi.on("session_shutdown", () => {
    store = createStore([]);
    announced.clear();
  });

  registerJailedBash(pi, () => ({ jail, enabled }));

  pi.registerCommand("sandboxing", {
    description: "Show the secret rules, the jail, and what has been redacted",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines = [
        enabled ? "pi-sandboxing is active." : "pi-sandboxing is disabled by config.",
        jail === undefined
          ? "OS jail: none on this platform, so the shell is not confined."
          : `OS jail: ${jail.backend}, denying the home credential directories.`,
        `Needles: ${activeCount(store)} loaded, ${announced.size} redacted, ${burnedCount} burned.`,
        "Rules:",
        ...rules.map((rule) => `  ${rule.glob}  (${rule.source})`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      await Promise.resolve();
    },
  });
}

/**
 * Re-register `bash` so every command runs through the jail. The host's own
 * `spawnHook` rewrites the command before it spawns, which is why this
 * extension owns no child processes.
 */
function registerJailedBash(
  pi: ExtensionAPI,
  current: () => { jail: Jail | undefined; enabled: boolean },
): void {
  const settings = SettingsManager.create(process.cwd());
  const shellPath = resolveShell(settings);
  const spawnHook = (context: BashSpawnContext): BashSpawnContext => {
    const { jail, enabled } = current();
    return enabled
      ? { ...context, command: wrapCommand(jail, context.command, shellPath) }
      : context;
  };
  const options: BashToolOptions = { shellPath, spawnHook };
  const commandPrefix = settings.getShellCommandPrefix();
  if (commandPrefix !== undefined) {
    options.commandPrefix = commandPrefix;
  }
  const definition = createBashToolDefinition(process.cwd(), options);
  pi.registerTool({ ...definition, label: "bash (jailed)" });
}

/** The path argument of a gated tool, read off the call's input by name. */
function readPathArgument(
  input: JsonObject,
  toolName: string,
  extraTools: ReadonlyMap<string, string>,
): string | undefined {
  return stringField(input, extraTools.get(toolName) ?? "path");
}
