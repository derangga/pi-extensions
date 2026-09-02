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
 * The "Type something." escape does survive, on both variants.
 */

import { ROW_INTENT_META } from "./state/row-intent.js";
import type {
  QuestionAnswer,
  QuestionData,
  QuestionnaireResult,
  QuestionParams,
} from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";

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

/** Whether the host implements the select and input primitives. */
export function hasDialogUI(ui: unknown): ui is DialogUI {
  const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
  return typeof u?.select === "function" && typeof u?.input === "function";
}

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
    if (!q) continue;
    const header = q.header ? `[${q.header}] ` : "";
    const answer = q.multiSelect
      ? await askMultiSelect(ui, q, qi, header, dialogOpts)
      : await askSingleSelect(ui, q, qi, header, dialogOpts);
    if (answer === undefined) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

/** Undefined means the user dismissed the dialog, which cancels everything. */
async function askSingleSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<QuestionAnswer | undefined> {
  const options = q.options.map(formatOptionLine);
  options.push(`${q.options.length + 1}. ${ROW_INTENT_META.other.label}`);
  const chosen = await ui.select(`${header}${q.question}${buildPreviewBlock(q)}`, options, opts);
  if (chosen === undefined || chosen === null) return undefined;
  const idx = parseIndex(chosen, options.length);
  // A host that returns something outside the list it was given is
  // indistinguishable from a dismissal. Treating it as one beats fabricating
  // an answer the user never gave.
  if (idx === null) return undefined;
  const option = q.options[idx];
  if (option) {
    return {
      questionIndex,
      question: q.question,
      kind: "option",
      answer: option.label,
      // Spread rather than assigned: the envelope's contract is that the key is
      // absent when there was no preview, not present and undefined.
      ...(option.preview !== undefined && option.preview.length > 0
        ? { preview: option.preview }
        : {}),
    };
  }
  // The "Type something." row, which is the one index past the authored options.
  const typed = await ui.input(`${header}${q.question}\n\n${CUSTOM_ANSWER_TITLE}`, "", opts);
  if (typed === undefined || typed === null) return undefined;
  return { questionIndex, question: q.question, kind: "custom", answer: typed };
}

/** Undefined means the user dismissed the dialog, which cancels everything. */
async function askMultiSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<QuestionAnswer | undefined> {
  const list = q.options.map(formatOptionLine).join("\n");
  const value = await ui.input(
    `${header}${q.question}\n\n${list}\n\n${MULTI_SELECT_INSTRUCTIONS}`,
    MULTI_SELECT_PLACEHOLDER,
    opts,
  );
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // A deliberate empty commit, the same as pressing Next with nothing ticked.
    //
    // Kept explicit even though falling through reaches the same answer: with
    // no tokens the `every` below is vacuously true and produces an empty
    // selection anyway. Removing this would leave an important behaviour
    // resting on that, and no test could tell the two apart.
    return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
  }
  const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
  const indices = tokens.map((tok) =>
    /^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null,
  );
  if (indices.every((i): i is number => i !== null)) {
    const selected: string[] = [];
    for (const i of indices) {
      const label = q.options[i]?.label;
      if (label !== undefined && !selected.includes(label)) selected.push(label);
    }
    return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
  }
  // Any token that is not an index -- a word, or a number like "13" when there
  // are three options -- means the user typed an answer rather than picking
  // from the list. Keeping it verbatim is both the honest reading and the
  // multi-select half of the "Type something." escape.
  return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}
