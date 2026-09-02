import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: QuestionnaireResult;
}

/**
 * Turn a questionnaire result into the envelope the model reads. Pure of
 * `(result, params)`.
 *
 * Cancelled and "nothing to report" both collapse to `DECLINE_MESSAGE`, so the
 * model sees one canonical "the user did not answer" signal rather than having
 * to distinguish shades of it. Partial answers and a global note still ride
 * along in `details` for anything replaying the session.
 *
 * "Nothing to report" means no answers AND no global note. The note segment is
 * appended before that check on purpose: submitting a global note and nothing
 * else is a real answer, not a decline.
 */
export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
): ToolResult {
  if (!result || result.cancelled) {
    // The decline text stays canonical even when a global note rides a
    // cancelled result. The note survives in `details`, like partial answers.
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
      ...(result?.globalNote && result.globalNote.length > 0
        ? { globalNote: result.globalNote }
        : {}),
    });
  }

  const segments: string[] = [];
  // Iterate the questions rather than the answers so segments always follow the
  // order the model asked in, whatever order the user filled tabs.
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a));
  }
  if (result.globalNote && result.globalNote.length > 0) {
    // Raw multiline echo, no reformatting, trailing period matching the shape
    // of an answer segment.
    segments.push(`global note: ${result.globalNote}.`);
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

/**
 * One answer as an envelope segment: `"question"="answer"`, optionally followed
 * by the preview the user was looking at and the note they wrote.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
  const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
  if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
  if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
  return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult): ToolResult {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
