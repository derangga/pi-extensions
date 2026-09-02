/**
 * The public event contract.
 *
 * This module deliberately imports nothing. A footer, statusline or notifier
 * subscribes to these channels to know what is being asked and whether the
 * agent is waiting on a person; it should not have to load a render graph, or
 * a schema compiler, to read two strings and four interfaces. Adding an import
 * here defeats the reason the `./events` subpath exists, so there is a test
 * that fails if one appears.
 *
 * Stability rules for both channels:
 *
 *   1. Channel names never change once published. Subscribers hardcode them.
 *   2. Payload changes are append-only, and new fields ship optional.
 *      Listeners must tolerate fields they do not know.
 *   3. Anything breaking -- a rename, a retype, a removal, a change in when
 *      the event fires -- takes a new channel name and a period of emitting
 *      both.
 *   4. No version field inside a payload. The channel name carries the
 *      version, because that is what a subscriber matches on.
 *   5. Payloads stay JSON-safe: primitives, arrays and plain objects. No Set,
 *      Map, Date or class instance. Listeners forward these across process and
 *      network boundaries, and a Map arrives at the far end as `{}`.
 */

/** Fired once, as the questionnaire is put to the user. */
export const ASK_POPUP_PROMPT_EVENT = "pi-ask-popup:prompt" as const;

/** Fired true before the wait and false when it ends, however it ends. */
export const ASK_POPUP_BLOCKED_EVENT = "pi-ask-popup:blocked" as const;

export interface AskPopupPromptOption {
  label: string;
  description: string;
  /**
   * Whether the option carries markdown preview content. The content itself is
   * deliberately not shipped: it can run to hundreds of lines, and a listener
   * that wants to say "this one has details" only needs the boolean.
   */
  hasPreview: boolean;
}

export interface AskPopupPromptQuestion {
  /** The question text, as the agent wrote it. */
  question: string;
  /** The short chip shown beside the question. */
  header: string;
  /** Normalized from the optional parameter, so listeners never see undefined. */
  multiSelect: boolean;
  options: readonly AskPopupPromptOption[];
}

export interface AskPopupPromptEventPayload {
  questions: readonly AskPopupPromptQuestion[];
}

export interface AskPopupBlockedEventPayload {
  /** True while input is awaited; false once it is answered, cancelled or failed. */
  active: boolean;
}

/**
 * What `buildPromptPayload` reads. Declared structurally rather than imported
 * from the tool's typebox schemas: the shapes match, so the real parameters
 * satisfy this at the call site, and this file stays import-free.
 */
export interface PromptSourceOption {
  label: string;
  description: string;
  preview?: string | undefined;
}

export interface PromptSourceQuestion {
  question: string;
  header: string;
  multiSelect?: boolean | undefined;
  options: readonly PromptSourceOption[];
}

export interface PromptSource {
  questions: readonly PromptSourceQuestion[];
}

/**
 * Project the validated tool parameters onto the prompt payload. Copies field
 * by field rather than spreading: a spread would forward whatever else the
 * parameters happen to carry, and preview content is the thing this payload
 * exists to leave behind.
 */
export function buildPromptPayload(source: PromptSource): AskPopupPromptEventPayload {
  return {
    questions: source.questions.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
        hasPreview: typeof o.preview === "string" && o.preview.length > 0,
      })),
    })),
  };
}

export function buildBlockedPayload(active: boolean): AskPopupBlockedEventPayload {
  return { active };
}
