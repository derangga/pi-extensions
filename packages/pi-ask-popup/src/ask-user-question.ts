import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  COLLAPSE_KEY_OFF,
  formatKeySpecForDisplay,
  loadConfig,
  resolveCollapseKey,
  validateGuidanceFields,
} from "./config.js";
import {
  ASK_POPUP_BLOCKED_EVENT,
  ASK_POPUP_PROMPT_EVENT,
  buildBlockedPayload,
  buildPromptPayload,
} from "./events.js";
// Static import: the walker pulls only types, none of the render graph the
// session lazy-loads.
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import type {
  QuestionnaireSession,
  QuestionnaireSessionComponent,
  QuestionnaireSessionConfig,
} from "./state/questionnaire-session.js";
import { LABELS_BY_KIND, sentinelsToAppend, type WrappingSelectItem } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionData,
  type QuestionnaireError,
  type QuestionnaireResult,
  type QuestionParams,
  QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";

/** The tool's name, shared with the reconciler so the two cannot disagree. */
export const ASK_POPUP_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
  "Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
  "Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
  "Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Terminal bell. */
export const BEL = "\x07";

/**
 * Ring once, just before the wait, so someone who tabbed away notices.
 *
 * To stdout rather than `/dev/tty`, and only when stdout is a terminal. Both
 * halves matter: the check proves an interactive terminal owns the wait, and
 * writing to stdout keeps the byte out of a piped RPC transport, which would
 * otherwise ring the local machine for a dialog rendering in a remote host's
 * own window.
 */
function emitTerminalAttention(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(BEL);
  } catch {
    // Best effort. Failing to get someone's attention must not stop the
    // questionnaire from being asked.
  }
}

function emitPrompt(pi: ExtensionAPI, params: QuestionParams): void {
  pi.events.emit(ASK_POPUP_PROMPT_EVENT, buildPromptPayload(params));
}

function emitBlocked(pi: ExtensionAPI, active: boolean): void {
  pi.events.emit(ASK_POPUP_BLOCKED_EVENT, buildBlockedPayload(active));
}

/** The backstop for a host with no UI at all; the reconciler normally strips the tool first. */
function rejectWithoutUi() {
  return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

/** The native-dialog walk, bracketed by the blocked pair and the bell. */
async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams) {
  emitBlocked(pi, true);
  try {
    emitTerminalAttention();
    return buildQuestionnaireResponse(await runRpcQuestionnaire(ui, typed), typed);
  } finally {
    // In a finally so a listener is never left showing that the agent is
    // waiting on someone who already answered.
    emitBlocked(pi, false);
  }
}

/**
 * Only the one export the loader needs. A `typeof import(...)` of the whole
 * namespace would say the same thing less precisely -- and this is the export
 * whose absence the stale-cache branch below is looking for.
 *
 * Type-only, so importing the names here does not pull the module into the
 * static graph and defeat the lazy load.
 */
type SessionModule = { QuestionnaireSession: typeof QuestionnaireSession };
type SessionRef = { current: QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
  | { ok: true; module: SessionModule }
  | {
      ok: false;
      error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">;
      message: string;
    };

/**
 * Load the render graph on first use, guarding its two failure shapes.
 *
 * Pi's jiti loader registers a module in its graph cache before evaluating it
 * and does not evict it when evaluation throws. So one failed load — a package
 * manager replacing the store mid-session, say — leaves every later import of
 * this specifier resolving to a namespace with no class in it, and that state
 * cannot be recovered inside the process.
 *
 * Both branches return an envelope that says the user never saw the questions.
 * That distinction is the entire point: a bare "not a constructor" would read
 * to the model as a failed answer rather than a failure to ask.
 *
 * The import is a parameter so both failures can be provoked directly. They
 * are otherwise reachable only by corrupting a real install mid-run, which is
 * not something a test suite can stage.
 */
export async function loadQuestionnaireSession(
  importSession: () => Promise<SessionModule> = () => import("./state/questionnaire-session.js"),
): Promise<SessionLoad> {
  let mod: SessionModule;
  try {
    mod = await importSession();
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: "session_load_failed",
      message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})`,
    };
  }
  if (typeof mod.QuestionnaireSession !== "function") {
    const keys = JSON.stringify(Object.keys(mod));
    return {
      ok: false,
      error: "stale_module_cache",
      message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
    };
  }
  return { ok: true, module: mod };
}

/**
 * Listen for the collapse key at the terminal, which is the only way to reach a
 * hidden overlay.
 *
 * Returns the remover, or undefined when the shortcut is off or the host has no
 * raw input hook. The caller reads `canReopenWhileHidden` from that, because
 * hiding the dialog without this listener would make it unreachable.
 */
function registerCollapseKeyListener(
  ctx: ExtensionContext,
  collapseKey: string,
  sessionRef: SessionRef,
  overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
  if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") {
    return undefined;
  }
  let hasAnnouncedHide = false;
  return ctx.ui.onTerminalInput((data) => {
    const handle = overlayHandleRef.current;
    if (!handle) return undefined;
    // Act only while this questionnaire is hidden (its own input is
    // unreachable) or actually focused. With another overlay on top, the key
    // belongs to that one; toggling from underneath it would be baffling.
    if (!handle.isHidden() && !handle.isFocused()) return undefined;
    if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
    // Kitty-protocol terminals report press, repeat and release separately.
    // Toggling on all three would make a tap reopen what it just closed, and a
    // held key flicker.
    if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
    sessionRef.current?.toggleCollapsedExternal();
    if (handle.isHidden() && !hasAnnouncedHide) {
      // Once only. The dialog has just vanished, so say how to get it back —
      // but repeating it every time would be nagging.
      hasAnnouncedHide = true;
      ctx.ui.notify?.(
        `ask_user_question hidden — press ${formatKeySpecForDisplay(collapseKey)} to reopen`,
        "info",
      );
    }
    return { consume: true };
  });
}

/**
 * The component factory Pi calls with a live TUI. Builds the session, keeps a
 * reference so the collapse listener can reach it, and hands back its component.
 */
function makeSessionFactory(config: {
  ctx: ExtensionContext;
  typed: QuestionParams;
  itemsByTab: WrappingSelectItem[][];
  collapseKey: string;
  canReopenWhileHidden: boolean;
  sessionRef: SessionRef;
  Session: SessionModule["QuestionnaireSession"];
}) {
  const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, Session } = config;
  return (
    tui: TUI,
    theme: Theme,
    keybindings: QuestionnaireSessionConfig["keybindings"],
    done: (result: QuestionnaireResult) => void,
  ): QuestionnaireSessionComponent => {
    const session = new Session({
      tui,
      theme,
      params: typed,
      itemsByTab,
      done,
      keybindings,
      editInput: async (value) => {
        try {
          // Imported per invocation, not hoisted: the external editor is used
          // rarely and pulls a settings manager with it.
          const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
            import("@earendil-works/pi-coding-agent"),
            import("./state/external-editor.js"),
          ]);
          const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
            projectTrusted: ctx.isProjectTrusted(),
          }).getExternalEditorCommand();
          if (!editorCommand) throw new Error("No external editor command is configured");
          return await editWithExternalEditor(tui, editorCommand, value);
        } catch (error) {
          // Reported, then undefined, which the session reads as "keep the
          // draft". Losing what someone typed because their editor is
          // misconfigured would be the worst possible response.
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`External editor failed: ${message}`, "error");
          return undefined;
        }
      },
      collapseKey,
      canReopenWhileHidden,
    });
    sessionRef.current = session;
    return session.component;
  };
}

/**
 * A rendered questionnaire always resolves a result, cancel included. So
 * undefined means the host could not render it, never that the user declined —
 * and the two must not be confused, because one is a decision and the other is
 * a malfunction. RPC builds too old to advertise their mode land here.
 */
async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams) {
  if (hasDialogUI(ctx.ui)) {
    return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
  }
  return buildToolResult(ERROR_NO_CUSTOM_UI, {
    answers: [],
    cancelled: true,
    error: "no_custom_ui",
  });
}

/** The rows for one question: its authored options, then whichever sentinels apply. */
export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
  const items: WrappingSelectItem[] = question.options.map((o) => ({
    kind: "option",
    label: o.label,
    description: o.description,
  }));
  for (const kind of sentinelsToAppend(question)) {
    items.push({ kind, label: LABELS_BY_KIND[kind] });
  }
  return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
  `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
  `Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
  "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

/**
 * Guidance comes from the global config layer only.
 *
 * Two reasons, and the second is the one that decides it. Registration happens
 * before any context exists, so there is no cwd to read a project layer from
 * and no trust decision to consult. And guidance is text folded into the
 * model's own prompt: honouring it from a repository would let a checked-in
 * file rewrite what the agent is told, which is exactly what project trust
 * exists to prevent. The collapse key, a local UI preference, does read both
 * layers.
 */
function loadGuidance(): {
  guidance: ReturnType<typeof validateGuidanceFields>;
  warnings: readonly string[];
} {
  const { config, warnings } = loadConfig({ agentDir: getAgentDir() });
  return { guidance: validateGuidanceFields(config.guidance), warnings };
}

export function registerAskPopupTool(pi: ExtensionAPI): void {
  const { guidance, warnings } = loadGuidance();
  // Reported once, on first use, because registration has no UI to report to.
  // Config problems are worth surfacing: silently ignoring a file someone wrote
  // makes the setting look broken rather than mistyped.
  let pendingWarnings: readonly string[] = warnings;

  pi.registerTool({
    name: ASK_POPUP_TOOL_NAME,
    label: "Ask User Question",
    description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
    promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const typed = params as unknown as QuestionParams;
      if (!ctx.hasUI) return rejectWithoutUi();

      for (const warning of pendingWarnings) ctx.ui.notify?.(warning, "warning");
      pendingWarnings = [];

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return buildToolResult(validation.message, {
          answers: [],
          cancelled: true,
          error: validation.error,
        });
      }

      emitPrompt(pi, typed);

      // Hosts that advertise their mode go straight to the walker and never
      // import the render graph at all. Older RPC builds fall through to the
      // undefined-result backstop below.
      if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
        return runRpcPath(pi, ctx.ui, typed);
      }

      // A host that claims a UI but offers neither the overlay nor the dialog
      // primitives is malformed, and calling `custom` on it throws a bare
      // TypeError that reaches the model as a broken tool rather than an
      // unsupported one. Answer honestly instead: nobody saw the questions.
      if (typeof (ctx.ui as { custom?: unknown }).custom !== "function") {
        return resolveUndefinedResult(ctx, typed);
      }

      const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) =>
        buildItemsForQuestion(q),
      );

      const sessionLoad = await loadQuestionnaireSession();
      if (!sessionLoad.ok) {
        return buildToolResult(sessionLoad.message, {
          answers: [],
          cancelled: true,
          error: sessionLoad.error,
        });
      }
      const { QuestionnaireSession } = sessionLoad.module;

      // Both layers here: unlike guidance, this only binds a key in the user's
      // own terminal, and a project pinning a shortcut that suits its docs is
      // reasonable. `resolveCollapseKey` refuses anything malformed.
      const collapseKey = resolveCollapseKey(
        loadConfig({
          agentDir: getAgentDir(),
          ...(ctx.isProjectTrusted() ? { projectDir: ctx.cwd } : {}),
        }).config,
      );

      const sessionRef: SessionRef = { current: null };
      const overlayHandleRef: OverlayHandleRef = { current: undefined };
      const removeOverlayInputListener = registerCollapseKeyListener(
        ctx,
        collapseKey,
        sessionRef,
        overlayHandleRef,
      );
      // Hiding is reversible only through that listener, so the session may
      // hide the overlay only when it was actually registered.
      const canReopenWhileHidden = removeOverlayInputListener !== undefined;

      emitBlocked(pi, true);
      try {
        emitTerminalAttention();
        const result = await ctx.ui.custom<QuestionnaireResult>(
          makeSessionFactory({
            ctx,
            typed,
            itemsByTab,
            collapseKey,
            canReopenWhileHidden,
            sessionRef,
            Session: QuestionnaireSession,
          }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "bottom-center",
              width: "100%",
              maxHeight: "100%",
              margin: { left: 0, right: 0, bottom: 0 },
            },
            onHandle: (handle) => {
              overlayHandleRef.current = handle;
              sessionRef.current?.setOverlayHandle(handle);
            },
          },
        );

        if (result === undefined) return resolveUndefinedResult(ctx, typed);
        return buildQuestionnaireResponse(result, typed);
      } finally {
        removeOverlayInputListener?.();
        emitBlocked(pi, false);
      }
    },
  });
}

export { buildQuestionnaireResponse, buildToolResult };
