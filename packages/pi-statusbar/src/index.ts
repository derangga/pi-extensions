/**
 * pi-statusbar — a footer with three presets, emoji or nerd icons, and a
 * thinking-level segment coloured by the level.
 *
 * Pi resolves this through `pi.extensions` and loads it with jiti, so it ships
 * as raw TypeScript with no build step.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applyColors, hasThemeColor, resolveColorLevel } from "./colors.js";
import { registerStatusbarCommand } from "./command.js";
import { getConfigPath, loadConfig, saveConfig, STATUS_KEY } from "./config.js";
import { collectStatusbarData } from "./data.js";
import { gitCommandsFor, type GitCommand } from "./git.js";
import { renderStatusbar } from "./render.js";
import type { StatusbarConfig } from "./types.js";
import { WidgetStore } from "./widgets/store.js";

/** What other extensions see in the status row while this one owns the footer. */
const STATUS_LABEL = "pi-statusbar";

export default async function statusbarExtension(pi: ExtensionAPI): Promise<void> {
  const loaded = await loadConfig();

  let config: StatusbarConfig = loaded.config;
  let store = WidgetStore.fromConfig(config);
  let gitCommands: ReadonlySet<GitCommand> | undefined = gitCommandsFor(config.lines);
  /** Reported at the next apply, since a config load has no UI context to speak through. */
  let configError = loaded.error;
  /** Set while a footer is mounted. The thinking-level repaint goes through it. */
  let requestRender: (() => void) | undefined;

  function replaceConfig(next: StatusbarConfig): void {
    config = next;
    store = WidgetStore.fromConfig(config);
    gitCommands = gitCommandsFor(config.lines);
  }

  /**
   * The label other extensions see in the status row, painted through the same
   * ladder every widget uses.
   *
   * Not `theme.fg("accent", …)` directly, which is what upstream does. Theme.fg
   * throws on a color the loaded theme omits, and this call sits inside the
   * session_start handler: a throw here rejects the handler and the footer never
   * mounts at all. Going through applyColors also means the label honours
   * NO_COLOR, which a raw theme call ignores.
   */
  function statusLabel(ctx: ExtensionContext): string {
    const accent = hasThemeColor(ctx.ui.theme, "accent") ? "pi:accent" : "cyan";
    const colorLevel = resolveColorLevel(process.env, ctx.ui.theme);
    return applyColors(STATUS_LABEL, accent, undefined, false, colorLevel, ctx.ui.theme);
  }

  function apply(ctx: ExtensionContext): void {
    if (configError !== undefined) {
      ctx.ui.notify(`pi-statusbar: ${configError}`, "warning");
      configError = undefined;
    }

    if (!ctx.hasUI || !config.enabled) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, statusLabel(ctx));
    ctx.ui.setFooter((tui, theme, footerData) => {
      const ownRequestRender = (): void => tui.requestRender();
      requestRender = ownRequestRender;
      const unsubscribeBranch = footerData.onBranchChange(ownRequestRender);

      return {
        dispose(): void {
          unsubscribeBranch();
          // Only when the handle is still ours. A later apply() mounts its
          // footer before this dispose runs, and clearing unconditionally would
          // leave the live footer with no way to repaint on a level change.
          if (requestRender === ownRequestRender) requestRender = undefined;
        },
        // Required by Component, and there is nothing to drop: every draw reads
        // its values fresh, so a theme change lands on the next render anyway.
        invalidate(): void {},
        render(width: number): string[] {
          const data = collectStatusbarData({
            ctx,
            pi,
            branchHint: footerData.getGitBranch(),
            gitCommands,
            requestRender: ownRequestRender,
          });
          return renderStatusbar(store, data, width, {
            // Asked per draw, not once at load: the theme arrives with the
            // footer handle, and the user can change it mid-session.
            colorLevel: resolveColorLevel(process.env, theme),
            theme,
            getExtensionStatuses: () => footerData.getExtensionStatuses(),
          });
        },
      };
    });
  }

  registerStatusbarCommand(pi, {
    current: () => config,
    // Repaint before persisting. A change the user just asked for is live for
    // this session whichever way the write goes, and saying so beats a command
    // that appears to have done nothing because the disk refused it.
    commit: async (next, ctx) => {
      replaceConfig(next);
      apply(ctx);
      try {
        await saveConfig(next);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `pi-statusbar: could not save ${getConfigPath()}: ${reason} (the change applies to this session only)`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const reloaded = await loadConfig();
    configError = reloaded.error;
    replaceConfig(reloaded.config);
    apply(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    apply(ctx);
  });

  // Upstream never subscribes to this, so a level change reaches the footer only
  // on the next unrelated redraw. For a segment whose colour is the level, that
  // reads as the feature being broken.
  pi.on("thinking_level_select", () => {
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
