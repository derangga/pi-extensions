import {
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionnaireError,
  type QuestionParams,
  RESERVED_LABELS,
} from "./types.js";

export const ERROR_NO_QUESTIONS = "Error: At least one question is required";
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
export const ERROR_DUPLICATE_QUESTION = "Error: Question text must be unique within an invocation";
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`;
export const ERROR_DUPLICATE_OPTION_LABEL = "Error: Option labels must be unique within a question";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>(RESERVED_LABELS);

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: QuestionnaireError; message: string };

/**
 * Runtime validator for tool parameters. Pure. Covers every guard except
 * `no_ui`, which depends on host state and stays at the call site.
 *
 * Upstream documents the reserved-label check as needing to precede the
 * duplicate-label check. It reads well but is unobservable: a reserved label
 * trips on its FIRST occurrence, when `seenLabels` cannot yet contain it, so no
 * option is ever both reserved and a duplicate. Two `"Other"` options return
 * `reserved_label` at index 0 under either ordering, and index 1 is
 * unreachable. Swapping these two blocks changes no output for any input.
 *
 * The order is kept because it reads in order of severity, not because
 * behavior depends on it. Do not add a test claiming to pin the precedence:
 * it would pass under both orderings and assert nothing.
 */
export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
  if (typed.questions.length === 0) {
    return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
  }
  if (typed.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };
  }

  const seenQuestions = new Set<string>();
  for (const q of typed.questions) {
    if (seenQuestions.has(q.question)) {
      return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
    }
    seenQuestions.add(q.question);
  }

  for (const q of typed.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (RESERVED_LABEL_SET.has(o.label)) {
        return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
      }
      if (seenLabels.has(o.label)) {
        return {
          ok: false,
          error: "duplicate_option_label",
          message: ERROR_DUPLICATE_OPTION_LABEL,
        };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}
