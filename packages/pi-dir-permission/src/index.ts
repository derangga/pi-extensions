/**
 * pi-dir-permission — Pi extension. Confines the file tools to the working
 * directory and grants access to anything outside it one dialog at a time.
 *
 * Pi has no filesystem sandbox: `read`, `write` and the rest resolve whatever
 * absolute path they are handed. This extension is the boundary, built on the
 * one hook that can refuse a call (`tool_call`), so the permission it manages
 * only exists while it is loaded.
 *
 * Zero runtime dependencies: the host provides everything
 * (@earendil-works/pi-coding-agent, @earendil-works/pi-tui) as peers.
 *
 * Deliberately outside the boundary: `bash` and `powershell`. A shell command
 * is a string, and picking the paths out of one is guesswork that would block
 * harmless commands while still missing `cd .. && cat`. This is a workspace
 * boundary, not a security boundary, and the README says so.
 */
import { join } from "node:path";
import {
  baselineRoots,
  grantLabel,
  isAllowed,
  isDirectory,
  resolveCandidate,
  type Grant,
} from "./boundary.js";
import { DEFAULT_CONFIG, loadConfig, statusText, type DirPermissionConfig } from "./config.js";
import { blockReason, boundaryNotice, inspectToolCall, type GateRequest } from "./gate.js";
import { pickDirectory } from "./picker.js";
import { readGrants, sameGrants, STATE_TYPE } from "./state.js";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

const STATUS_KEY = "dir-permission";

/** What the user chose in the block dialog. */
type Choice = "once" | "grant" | "deny";

export default function dirPermissionExtension(pi: ExtensionAPI): void {
  let config: DirPermissionConfig = DEFAULT_CONFIG;
  let grants: Grant[] = [];
  let baseline: readonly string[] = [];
  let cwd = "";

  function allowedRoots(): readonly string[] {
    return [...baseline, ...grants.map((grant) => grant.absolutePath)];
  }

  function publishStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, statusText(grants, config));
  }

  function persist(): void {
    pi.appendEntry(STATE_TYPE, { dirs: grants.map((grant) => ({ ...grant })) });
  }

  /**
   * Rebuild the grant list from the branch. Rewinding past a grant revokes it,
   * because the entry that recorded it is no longer on the branch.
   */
  function replayGrants(ctx: ExtensionContext): void {
    const replayed = readGrants(ctx.sessionManager.getBranch());
    if (sameGrants(grants, replayed)) {
      return;
    }
    grants = replayed;
    publishStatus(ctx);
  }

  function addGrant(absolutePath: string, ctx: ExtensionContext): string {
    if (isAllowed(allowedRoots(), absolutePath)) {
      return `Already allowed: ${absolutePath}`;
    }
    grants.push({ absolutePath, label: grantLabel(absolutePath) });
    persist();
    publishStatus(ctx);
    return `Allowed ${absolutePath} for this session.`;
  }

  /**
   * Ask which scope to open, if any. Returning undefined (the user pressed
   * escape) counts as a refusal: the safe reading of "I did not answer" is
   * that the call does not proceed.
   */
  async function askForGrant(request: GateRequest, ctx: ExtensionContext): Promise<Choice> {
    const grantDir = `Allow ${request.scopes.dir} for this session`;
    const grantRepo =
      request.scopes.repoRoot === undefined
        ? undefined
        : `Allow ${request.scopes.repoRoot} (whole repository) for this session`;
    const choices = [
      "Allow once, this call only",
      grantDir,
      ...(grantRepo === undefined ? [] : [grantRepo]),
      "Deny",
    ];

    const selected = await ctx.ui.select(
      `${request.toolName} wants ${request.target}, outside the allowed directories`,
      choices,
    );
    if (selected === "Allow once, this call only") {
      return "once";
    }
    if (selected === grantDir) {
      addGrant(request.scopes.dir, ctx);
      return "grant";
    }
    if (
      grantRepo !== undefined &&
      selected === grantRepo &&
      request.scopes.repoRoot !== undefined
    ) {
      addGrant(request.scopes.repoRoot, ctx);
      return "grant";
    }
    return "deny";
  }

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    baseline = baselineRoots(cwd, getAgentDir());
    // The project layer is read only for a trusted checkout: an untrusted one
    // must not be able to widen its own boundary by editing a file in it.
    const loaded = loadConfig(
      getAgentDir(),
      ctx.isProjectTrusted() ? join(cwd, CONFIG_DIR_NAME) : undefined,
    );
    config = loaded.config;
    grants = readGrants(ctx.sessionManager.getBranch());
    publishStatus(ctx);
    if (ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(warning, "warning");
      }
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    replayGrants(ctx);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + boundaryNotice(allowedRoots()),
  }));

  pi.on("tool_call", async (event, ctx) => {
    const request = inspectToolCall(event, cwd, allowedRoots(), homedir(), config.gatedTools);
    if (request === undefined) {
      return;
    }
    // Nobody can answer a dialog in RPC, JSON or print mode, and a boundary
    // that opens itself when unattended is not a boundary.
    if (!ctx.hasUI) {
      return { block: true, reason: blockReason(request, false) };
    }
    const choice = await askForGrant(request, ctx);
    return choice === "deny" ? { block: true, reason: blockReason(request, true) } : undefined;
  });

  pi.registerCommand("dir-perm-add", {
    description: "Allow a directory outside the workspace for this session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const typed = args.trim();
      const chosen =
        typed === "" ? await promptForDirectory(ctx) : resolveCandidate(typed, ctx.cwd);
      if (chosen === undefined || chosen === "") {
        return;
      }
      if (!isDirectory(chosen)) {
        ctx.ui.notify(`Not a directory: ${chosen}`, "error");
        return;
      }
      ctx.ui.notify(addGrant(chosen, ctx), "info");
    },
  });

  pi.registerCommand("dir-permissions", {
    description: "List allowed directories and revoke one",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (grants.length === 0) {
        ctx.ui.notify(
          "No directories allowed beyond the workspace. /dir-perm-add <path> allows one.",
          "info",
        );
        return;
      }
      // Every row names the verb. Pi's own selector footer says "Enter select"
      // and an extension cannot change that text, so the option carries the
      // consequence instead of the footer.
      const choices = grants.map((grant) => `Revoke ${grant.label} — ${grant.absolutePath}`);
      const selected = await ctx.ui.select(
        `Directory permissions — ${grants.length} allowed`,
        choices,
      );
      const index = selected === undefined ? -1 : choices.indexOf(selected);
      const revoked = index < 0 ? undefined : grants[index];
      if (revoked === undefined) {
        return;
      }
      grants.splice(index, 1);
      persist();
      publishStatus(ctx);
      ctx.ui.notify(`Revoked ${revoked.absolutePath}.`, "info");
    },
  });
}

/**
 * The picker draws its own component, which only the TUI can host. Every other
 * host that still has dialogs falls back to typing the path.
 */
async function promptForDirectory(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    return pickDirectory(ctx.ui, ctx.cwd);
  }
  const typed = await ctx.ui.input("Directory path:", "");
  return typed === undefined || typed.trim() === ""
    ? undefined
    : resolveCandidate(typed.trim(), ctx.cwd);
}
