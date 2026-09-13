import { formatAnswerScalar } from "./format-answer.js";
import { ROW_INTENT_META } from "../state/row-intent.js";
import type {
  ChatRequested,
  QuestionAnswer,
  QuestionnaireResult,
  QuestionParams,
  UnansweredNote,
} from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const CHAT_REQUEST_INSTRUCTION =
  "This is NOT a decline. End your turn now without asking a new question — the user's next message is their clarification of that question. Respond to it, then re-ask only the questions that remain unanswered.";
export const TIMED_OUT_MESSAGE =
  "Questionnaire timed out — the user did not respond within the configured timeout. The user never saw a decline; do NOT treat this as a rejection. Ask the questions as plain chat text instead or retry.";
export const HOST_ERROR_MESSAGE =
  "The host replied with a value that was never offered, so the questionnaire could not be completed. Nobody declined and nobody answered — do NOT treat this as a rejection. Ask the questions as plain chat text instead.";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
/** Opens the segment for a note whose question was never answered. */
export const UNANSWERED_NOTE_PREFIX = "note on";

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
  if (result?.error === "timed_out") {
    const details: QuestionnaireResult = {
      answers: result.answers,
      cancelled: true,
      error: "timed_out",
    };
    if (result.globalNote && result.globalNote.length > 0) {
      (details as { globalNote: string }).globalNote = result.globalNote;
    }
    if (result.unansweredNotes && result.unansweredNotes.length > 0) {
      (details as { unansweredNotes: typeof result.unansweredNotes }).unansweredNotes =
        result.unansweredNotes;
    }
    return buildToolResult(TIMED_OUT_MESSAGE, details);
  }
  if (result?.error === "host_error") {
    // A broken host is not a decision. Sharing the decline text would tell the
    // model the user said no, when the user was never shown a working dialog.
    const details: QuestionnaireResult = {
      answers: result.answers,
      cancelled: true,
      error: "host_error",
    };
    if (result.hostErrorDetail && result.hostErrorDetail.length > 0) {
      (details as { hostErrorDetail: string }).hostErrorDetail = result.hostErrorDetail;
      return buildToolResult(
        `${HOST_ERROR_MESSAGE} (host sent: ${result.hostErrorDetail})`,
        details,
      );
    }
    return buildToolResult(HOST_ERROR_MESSAGE, details);
  }
  if (result?.chatRequested) {
    // A chat request is a decision, so it must not reach the decline collapse
    // below: the model would read "User declined to answer questions" for a
    // user who asked to talk. Segments are built for the answered questions
    // even though the marker alone already makes the result non-empty — a
    // chat close with nothing answered is still a chat close.
    const cr = result.chatRequested;
    const details: QuestionnaireResult = {
      answers: result.answers,
      cancelled: true,
      chatRequested: cr,
    };
    if (result.globalNote && result.globalNote.length > 0) {
      (details as { globalNote: string }).globalNote = result.globalNote;
    }
    if (result.unansweredNotes && result.unansweredNotes.length > 0) {
      (details as { unansweredNotes: typeof result.unansweredNotes }).unansweredNotes =
        result.unansweredNotes;
    }
    return buildToolResult(buildChatRequestMessage(cr, collectSegments(result, params)), details);
  }
  if (!result || result.cancelled) {
    // The decline text stays canonical even when a global note rides a
    // cancelled result. The note survives in `details`, like partial answers.
    const details: QuestionnaireResult = {
      answers: result?.answers ?? [],
      cancelled: true,
    };
    if (result?.error) {
      (details as { error: typeof result.error }).error = result.error;
    }
    if (result?.globalNote && result.globalNote.length > 0) {
      (details as { globalNote: string }).globalNote = result.globalNote;
    }
    if (result?.unansweredNotes && result.unansweredNotes.length > 0) {
      (details as { unansweredNotes: typeof result.unansweredNotes }).unansweredNotes =
        result.unansweredNotes;
    }
    return buildToolResult(DECLINE_MESSAGE, details);
  }

  // Indexed once per segment walk inside `collectSegments`; nothing here needs
  // the maps directly.
  const segments = collectSegments(result, params);
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

/** First entry per `questionIndex` wins, which is what `Array.find` did. */
function byQuestionIndex<T extends { questionIndex: number }>(items: readonly T[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const item of items) {
    if (!out.has(item.questionIndex)) {
      out.set(item.questionIndex, item);
    }
  }
  return out;
}

/**
 * The envelope segments for one result, in ask order.
 *
 * Iterates the questions rather than the answers so segments always follow the
 * order the model asked in, whatever order the user filled tabs. A note with no
 * answer behind it still belongs in ask order, so it is emitted inline rather
 * than grouped at the end — which is also why a questionnaire submitted with
 * nothing but such a note counts as answered rather than declined. The global
 * note rides last, echoed raw with a trailing period matching an answer
 * segment's shape.
 */
function collectSegments(result: QuestionnaireResult, params: QuestionParams): string[] {
  const answerByIndex = byQuestionIndex(result.answers);
  const noteByIndex = byQuestionIndex(result.unansweredNotes ?? []);
  const segments: string[] = [];
  for (let i = 0; i < params.questions.length; i++) {
    const a = answerByIndex.get(i);
    if (a) {
      segments.push(buildAnswerSegment(a));
      continue;
    }
    const n = noteByIndex.get(i);
    if (n) {
      segments.push(buildUnansweredNoteSegment(n));
    }
  }
  if (result.globalNote && result.globalNote.length > 0) {
    segments.push(`global note: ${result.globalNote}.`);
  }
  return segments;
}

/**
 * The envelope for a "Chat about this" close.
 *
 * Answers already given ride in ask order as usual, then the marker's own
 * segment tells the model what the selection means and what to do next: stop,
 * read the user's next message as the clarification, and re-ask only what is
 * still missing afterwards. Partial answers are stated explicitly so the model
 * does not re-ask what it already has.
 */
function buildChatRequestMessage(
  chatRequested: ChatRequested,
  segments: readonly string[],
): string {
  const parts: string[] = [
    `User selected "${ROW_INTENT_META.chat.label}" on question ${chatRequested.questionIndex + 1} ("${chatRequested.question}") — they want to clarify something before answering it.`,
  ];
  if (segments.length > 0) {
    parts.push(`Their answers to the earlier questions: ${segments.join(" ")}`);
  }
  parts.push(CHAT_REQUEST_INSTRUCTION);
  return parts.join(" ");
}

/**
 * One answer as an envelope segment: `"question"="answer"`, optionally followed
 * by the preview the user was looking at and the note they wrote.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
  const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
  if (a.preview && a.preview.length > 0) {
    parts.push(`selected preview: ${a.preview}`);
  }
  if (a.notes && a.notes.length > 0) {
    parts.push(`user notes: ${a.notes}`);
  }
  return `${parts.join(". ")}.`;
}

/**
 * A note whose question was never answered.
 *
 * Its own segment shape rather than an answer segment with a placeholder in the
 * answer slot: there is no answer to place, and a second "(no answer)" string
 * sitting one word away from `NO_INPUT_PLACEHOLDER` would be two
 * near-identical placeholders meaning different things.
 */
export function buildUnansweredNoteSegment(n: UnansweredNote): string {
  return `${UNANSWERED_NOTE_PREFIX} "${n.question}": ${n.note}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult): ToolResult {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
