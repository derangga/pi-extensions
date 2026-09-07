import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";

import { inChildSessionContext } from "./child-context.js";
import { registerSubagentCommand } from "./command.js";
import { Intercom } from "./intercom.js";
import { createWidgetHost, createWidgetRuns } from "./render.js";
import { modelSourceFrom } from "./resolve.js";
import { formatManagerError, Manager, type ManagerError } from "./run.js";
import { DEFAULT_SETTINGS, getSettingsPath, Settings, type SubagentSettings } from "./settings.js";
import { registerSubagentTools } from "./tools.js";

/**
 * Entry point. Pi resolves this through `pi.extensions` and loads it with jiti,
 * so it stays raw TypeScript with no build step.
 *
 * Effect owns the settings, the intercom and the run manager. It stops at this
 * boundary: the runtime is built once here and every Pi callback bridges into
 * it with `runPromise`, because Pi's own surface is callbacks and promises.
 */
export default function subagentExtension(pi: ExtensionAPI): void {
  if (inChildSessionContext()) return;

  /**
   * What the widget reads between repaints. A render is synchronous and cannot
   * await, so the manager pushes snapshots here and the TUI side never touches
   * Effect. The context only exists once a tool runs, which is also the first
   * moment there is anything to show.
   */
  const drawn = createWidgetRuns();
  let uiContext: ExtensionContext | undefined;
  const widget = createWidgetHost(drawn.current);

  const runtime = ManagedRuntime.make(
    Manager.layer({
      onChange: (next) => {
        drawn.replace(next);
        widget.update(uiContext);
      },
      // Three channels on Pi's own bus, so pi-statusbar or anything else can
      // render run state without importing this package. No RPC, and no
      // spawn-from-outside surface, until something asks for one.
      onEvent: (event) => pi.events.emit(event.channel, event),
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Settings.layer,
          Intercom.layer({
            send: (message, mode) => pi.sendUserMessage(message, { deliverAs: mode }),
          }),
        ),
      ),
    ),
  );

  /**
   * The one place a typed manager failure becomes something the model reads.
   * Pi turns a thrown tool error into an error tool result carrying the
   * message, which is exactly where these belong.
   */
  const call = async <A>(
    build: (manager: Manager["Service"]) => Effect.Effect<A, ManagerError>,
  ): Promise<A> => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const manager = yield* Manager;
        return yield* build(manager).pipe(
          Effect.match({
            onFailure: (error: ManagerError) =>
              ({ ok: false, message: formatManagerError(error) }) as const,
            onSuccess: (value: A) => ({ ok: true, value }) as const,
          }),
        );
      }),
    );
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.value;
  };

  registerSubagentTools(pi, {
    start: (tasks, ctx: ExtensionContext) => {
      uiContext = ctx;
      return call((manager) =>
        manager.start({
          tasks,
          cwd: ctx.cwd,
          parent: { model: ctx.model, thinking: ctx.thinkingLevel },
          parentSession: ctx.sessionManager.getSessionFile(),
          source: modelSourceFrom(ctx.modelRegistry),
        }),
      );
    },
    wait: (runId, taskId) => call((manager) => manager.wait(runId, taskId)),
    view: (runId) => call((manager) => manager.view(runId)),
    reply: (runId, taskId, message) => call((manager) => manager.reply(runId, taskId, message)),
    cancel: (runId) => call((manager) => manager.cancel(runId)),
  });

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

  /**
   * A settled run stops being drawn at the next turn rather than the moment it
   * settles: those rows are what the reader looks at while the answer lands.
   * The manager keeps the run either way, so `subagent_result` with its id
   * still returns everything it produced.
   */
  pi.on("agent_settled", () => {
    drawn.endTurn();
  });

  pi.on("agent_start", (_event, ctx) => {
    uiContext = ctx;
    if (!drawn.beginTurn()) return;
    if (drawn.current().length === 0) widget.clear(ctx);
    else widget.update(ctx);
  });

  pi.on("session_shutdown", () => {
    widget.clear(uiContext);
    return runtime.dispose();
  });
}
