import type { QuestionAnswer } from "./types.js";

/** Stand-in for an answer with no text. One placeholder for every variant. */
export const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

/**
 * Reduce an answer to its scalar string form.
 *
 * `variant` currently changes nothing: the branch that once distinguished the
 * review summary from the model-facing envelope is gone. It stays on the
 * signature because both call sites read better naming which surface they are
 * rendering, and because the distinction is likely to come back.
 *
 * The switch is exhaustive by way of a non-void return: adding a `kind` fails
 * to compile here.
 */
export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
  switch (a.kind) {
    case "multi":
      return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
    case "custom":
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case "option":
      return a.answer ?? NO_INPUT_PLACEHOLDER;
  }
}
