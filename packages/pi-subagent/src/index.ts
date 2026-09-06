import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect, ManagedRuntime } from "effect";

import { inChildSessionContext } from "./child-context.js";
import { registerSubagentCommand } from "./command.js";
import { DEFAULT_SETTINGS, getSettingsPath, Settings, type SubagentSettings } from "./settings.js";

/**
 * Entry point. Pi resolves this through `pi.extensions` and loads it with jiti,
 * so it stays raw TypeScript with no build step.
 *
 * Effect owns the settings and, later, the run manager. It stops at this
 * boundary: the runtime is built once here and every Pi callback bridges into
 * it with `runPromise`, because Pi's own surface is callbacks and promises.
 */
export default function subagentExtension(pi: ExtensionAPI): void {
  if (inChildSessionContext()) return;

  const runtime = ManagedRuntime.make(Settings.layer);

  /**
   * What the panel reads between keystrokes. A render runs several times a
   * second and cannot await, so the loaded settings are mirrored here and the
   * Effect side stays the only thing that writes them to disk.
   */
  let mirror: SubagentSettings = DEFAULT_SETTINGS;
  let warnings: readonly string[] = [];
  let warningsReported = false;

  void runtime
    .runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        mirror = yield* settings.current;
        warnings = settings.warnings;
      }),
    )
    .catch(() => {
      // Load already falls back to defaults and reports through `warnings`;
      // reaching here means the runtime itself failed, and the defaults in
      // `mirror` are the right thing to keep going with.
    });

  registerSubagentCommand(pi, {
    current: () => mirror,
    path: getSettingsPath,
    takeWarnings: () => {
      if (warningsReported) return [];
      warningsReported = true;
      return warnings;
    },
    commit: async (next: SubagentSettings, ctx: ExtensionCommandContext) => {
      // Memory first, so the row under the cursor shows what was chosen, then
      // disk. A failed write says so and leaves the choice standing rather
      // than reverting a row while the user is looking at it.
      mirror = next;
      await runtime
        .runPromise(
          Effect.gen(function* () {
            const settings = yield* Settings;
            yield* settings.update(next);
          }),
        )
        .catch((cause: unknown) => {
          ctx.ui.notify(`pi-subagent: could not save settings: ${String(cause)}`, "error");
        });
    },
  });

  pi.on("session_shutdown", () => {
    void runtime.dispose();
  });
}
