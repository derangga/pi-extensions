/**
 * The dialog-primitive path for hosts that cannot render the overlay.
 *
 * The TUI path draws a tabbed overlay through `ctx.ui.custom()`, which needs a
 * real terminal. RPC hosts -- the VS Code pendant, ACP clients like Zed and
 * Paseo -- report `hasUI: true`, because Pi's dialog sub-protocol genuinely
 * works there, and yet `ui.custom()` resolves undefined without drawing
 * anything. What those hosts do have is `ui.select()` and `ui.input()`, which
 * they render natively. So this walks the questions one dialog at a time and
 * returns the same `QuestionnaireResult` the overlay would, feeding the same
 * envelope.
 *
 * What is lost, and why it cannot be helped: the select and input primitives
 * take a title and a list, so there is no side-by-side preview pane (previews
 * fold into the title), no tabbed review (one dialog per question), and
 * multi-select becomes a free-text list of numbers instead of checkbox rows.
 * Notes do not exist on this path at all -- neither primitive carries a field
 * for them, and inventing a second dialog to collect one would double the
 * number of prompts for something most answers never use.
 *
 * The "Type something." escape and the "Chat About This" escape both survive,
 * on both variants: the select lists carry both rows, and the multi-select
 * input accepts the word `chat` as the row's counterpart.
 */

import { ROW_INTENT_META } from "./state/row-intent.js";
import type {
  QuestionAnswer,
  QuestionData,
  QuestionnaireResult,
  QuestionParams,
} from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text. Reply "chat" to set this question aside and discuss it in chat instead.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";
/** The word a multi-select input reply must equal to trigger the chat escape. */
const CHAT_KEYWORD = "chat";

/** How much of an option's preview is folded into a select title before truncation. */
const MAX_PREVIEW_CHARS = 600;

/**
 * The slice of Pi's UI context this walker needs, declared structurally.
 * `hasDialogUI` is the runtime gate that makes the shape trustworthy: jiti
 * transpiles without type-checking, so a host that does not implement these
 * would otherwise fail at the call rather than at the check.
 */
export type DialogUI = {
  select: (
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<string | undefined>;
  input: (
    title: string,
    placeholder?: string,
    opts?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<string | undefined>;
};

/**
 * Whether the host implements the select and input primitives.
 *
 * `typeof`, not `instanceof Function`: a method that arrives from another realm
 * — an Electron context bridge, a VM context, a proxy around a host object — is
 * callable but fails an `instanceof` against this realm's `Function`, and the
 * walker would then decline a host that works.
 */
export function hasDialogUI(ui: unknown): ui is DialogUI {
  // SAFETY: safe cast — value is validated at boundary or test fixture with known shape.
  const u = ui as Partial<DialogUI> | null | undefined;
  return typeof u?.select === "function" && typeof u?.input === "function";
}

/**
 * What one native dialog produced.
 *
 * `dismissed` is the user pressing Esc, which cancels the questionnaire.
 * `host_error` is the host replying with something it was never offered —
 * neither a decision nor an answer, and the two must not collapse into one
 * result, because a decline tells the model the user said no.
 */
type AskOutcome =
  | { kind: "answer"; answer: QuestionAnswer }
  | { kind: "chat"; question: string }
  | { kind: "dismissed" }
  | { kind: "host_error"; detail: string };

const DISMISSED: AskOutcome = { kind: "dismissed" };

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
  return `${index + 1}. ${option.label} — ${option.description}`;
}

/**
 * Read a leading option number as a zero-based index, or null when it is not
 * one. `Number.parseInt` reads "2. B — b" as 2, which is what makes it work on
 * the string a select dialog hands back. NaN and out-of-range both fail the
 * bounds check.
 */
function parseIndex(token: string, count: number): number | null {
  const i = Number.parseInt(token, 10) - 1;
  return i >= 0 && i < count ? i : null;
}

/** Previews folded into the title, since there is no pane to put them in. */
function buildPreviewBlock(question: QuestionData): string {
  const blocks = question.options.flatMap((o, i) =>
    o.preview !== undefined && o.preview.length > 0
      ? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
      : [],
  );
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/**
 * Walk the questionnaire, one native dialog at a time.
 *
 * Dismissing any dialog cancels the whole questionnaire, which is what Esc
 * does in the overlay, and the shared envelope turns that into a decline. Any
 * other outcome produces one `QuestionAnswer` per question, so what the model
 * receives is indistinguishable from the overlay path.
 */
export async function runRpcQuestionnaire(
  ui: DialogUI,
  params: QuestionParams,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  const dialogOpts = params.timeout === undefined ? undefined : { timeout: params.timeout };
  for (let qi = 0; qi < params.questions.length; qi++) {
    const q = params.questions[qi];
    if (!q) {
      continue;
    }
    const header = q.header ? `[${q.header}] ` : "";
    const outcome = q.multiSelect
      ? await askMultiSelect(ui, q, qi, header, dialogOpts)
      : await askSingleSelect(ui, q, qi, header, dialogOpts);
    if (outcome.kind === "dismissed") {
      return { answers, cancelled: true };
    }
    if (outcome.kind === "chat") {
      // Same shape the overlay's chat row produces: everything answered before
      // this question rides along, the marker names this one, and the rest of
      // the walk is abandoned.
      return {
        answers,
        cancelled: true,
        chatRequested: { questionIndex: qi, question: outcome.question },
      };
    }
    if (outcome.kind === "host_error") {
      return { answers, cancelled: true, error: "host_error", hostErrorDetail: outcome.detail };
    }
    answers.push(outcome.answer);
  }
  return { answers, cancelled: false };
}

/** Dismissal cancels everything; a reply outside the offered list is the host's fault. */
async function askSingleSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<AskOutcome> {
  const options = q.options.map(formatOptionLine);
  options.push(`${q.options.length + 1}. ${ROW_INTENT_META.other.label}`);
  options.push(`${q.options.length + 2}. ${ROW_INTENT_META.chat.label}`);
  const chosen = await ui.select(`${header}${q.question}${buildPreviewBlock(q)}`, options, opts);
  if (chosen === undefined || chosen === null) {
    return DISMISSED;
  }
  const idx = parseIndex(chosen, options.length);
  // A host returning something outside the list it was given used to read as a
  // dismissal, which told the model the user had declined. Nobody declined
  // anything: the host is broken, or is rewriting the option text (a localising
  // client will), and the model needs to hear which.
  if (idx === null) {
    return { kind: "host_error", detail: `selection not in the offered list: "${chosen}"` };
  }
  const option = q.options[idx];
  if (option) {
    const answer: QuestionAnswer = {
      questionIndex,
      question: q.question,
      kind: "option",
      answer: option.label,
    };
    if (option.preview !== undefined && option.preview.length > 0) {
      // SAFETY: preview is an optional string; present only when non-empty per contract.
      (answer as QuestionAnswer & { preview: string }).preview = option.preview;
    }
    return { kind: "answer", answer };
  }
  // The "Chat About This" row, one index past the authored options plus the
  // free-text row.
  if (idx === q.options.length + 1) {
    return { kind: "chat", question: q.question };
  }
  // The "Type something." row, which is the one index past the authored options.
  const typed = await ui.input(`${header}${q.question}\n\n${CUSTOM_ANSWER_TITLE}`, "", opts);
  if (typed === undefined || typed === null) {
    return DISMISSED;
  }
  return {
    kind: "answer",
    answer: { questionIndex, question: q.question, kind: "custom", answer: typed },
  };
}

/**
 * Dismissal cancels everything. Nothing else here can be a host error: the text
 * comes from the user's own keyboard, so an out-of-range number like "13" on a
 * three-option question is a typed answer, not a host returning garbage.
 */
async function askMultiSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<AskOutcome> {
  const list = q.options.map(formatOptionLine).join("\n");
  const value = await ui.input(
    `${header}${q.question}\n\n${list}\n\n${MULTI_SELECT_INSTRUCTIONS}`,
    MULTI_SELECT_PLACEHOLDER,
    opts,
  );
  if (value === undefined || value === null) {
    return DISMISSED;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // A deliberate empty commit, the same as pressing Next with nothing ticked.
    //
    // Kept explicit even though falling through reaches the same answer: with
    // no tokens the `every` below is vacuously true and produces an empty
    // selection anyway. Removing this would leave an important behaviour
    // resting on that, and no test could tell the two apart.
    return {
      kind: "answer",
      answer: { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] },
    };
  }
  // The chat escape. There is no row to focus in an input dialog, so the word
  // itself is the affordance, and it is matched exactly rather than split into
  // tokens: a reply of "1, chat, 3" is a custom answer naming the word, not a
  // mixed selection, and pretending otherwise would answer a question the user
  // asked to set aside. Case-insensitive because the instructions show it
  // lowercase and no dialog here punishes capitalisation anywhere else.
  if (trimmed.toLowerCase() === CHAT_KEYWORD) {
    return { kind: "chat", question: q.question };
  }
  const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
  const indices = tokens.map((tok) =>
    /^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null,
  );
  if (indices.every((i): i is number => i !== null)) {
    const selected: string[] = [];
    for (const i of indices) {
      const label = q.options[i]?.label;
      if (label !== undefined && !selected.includes(label)) {
        selected.push(label);
      }
    }
    return {
      kind: "answer",
      answer: { questionIndex, question: q.question, kind: "multi", answer: null, selected },
    };
  }
  // Any token that is not an index -- a word, or a number like "13" when there
  // are three options -- means the user typed an answer rather than picking
  // from the list. Keeping it verbatim is both the honest reading and the
  // multi-select half of the "Type something." escape.
  return {
    kind: "answer",
    answer: { questionIndex, question: q.question, kind: "custom", answer: trimmed },
  };
}
