# Tool schema

The full program surface of `ask_user_question`: what the model sends, what validation rejects, what comes back, and the event other extensions can listen to.

## Parameters

```ts
ask_user_question({
  questions: [
    {
      question: string,            // full question text, ends with "?"
      header: string,              // chip label, max 16 chars
      options: [
        {
          label: string,           // 1 to 5 words, max 60 chars
          description: string,     // what the choice means or its trade-off
          preview?: string,        // markdown rendered next to the options
        },
        // 2 to 4 options total
      ],
      multiSelect?: boolean,       // default false
    },
    // 1 to 4 questions total
  ],
  timeout?: number,                // ms, min 1000, auto-dismiss with countdown
})
```

### Limits

| Field | Constraint | Enforced by |
| --- | --- | --- |
| `questions` | 1 to 4 entries | TypeBox schema and `validateQuestionnaire` |
| `questions[].header` | max 16 characters | TypeBox schema only |
| `questions[].options` | 2 to 4 entries | TypeBox schema (both bounds) and `validateQuestionnaire` (minimum only) |
| `options[].label` | max 60 characters | TypeBox schema only |
| `options[].preview` | single-select questions only | tool description (multi-select tabs render checkbox rows) |
| `timeout` | integer at least 1000 | TypeBox schema only |

The two `maxLength` limits are checked by the param schema before `execute` runs. The runtime validator does not re-check them.

### Timeout

`timeout` is optional. When set, the dialog starts a live countdown shown in the footer and in the collapsed hint row. The first keystroke cancels the timer. If the countdown reaches zero, the questionnaire dismisses itself and returns `cancelled: true` with `error: "timed_out"`. This is not a decline. The model should retry or ask the same questions as plain chat text. A timed out result keeps the same `answers`, `globalNote`, and `unansweredNotes` the user had managed to leave behind, if any. No timeout means the dialog waits until the user acts.

### Reserved option labels

Using any of `"Other"`, `"Type something."`, or `"Next"` as an option label is rejected with `reserved_label`. The last two are the rows the dialog adds itself. `"Other"` is reserved because models are often primed to reach for it. Reservation is unconditional. A single-select question rejects `"Next"` even though that row is never added there.

## Validation errors

Every rejection returns `cancelled: true`, an empty `answers` array, and an `error` code. The `content[0].text` string is written for the model, not for a log.

| `error` | Cause |
| --- | --- |
| `no_questions` | `questions` was empty |
| `too_many_questions` | more than 4 questions in one call |
| `duplicate_question` | two questions with identical text |
| `empty_options` | a question carried fewer than 2 options |
| `reserved_label` | an option used a reserved label |
| `duplicate_option_label` | two options in one question share a label |
| `no_ui` | the run has no UI (`ctx.hasUI === false`) |
| `no_custom_ui` | the host cannot render custom UI and exposes no `select` or `input` dialogs |
| `session_load_failed` | the dialog module failed to import (store changed on disk mid session) |
| `stale_module_cache` | the loader cached a broken module after an earlier failed import. Needs a Pi restart |
| `timed_out` | the `timeout` countdown expired before the user acted |

`reserved_label` is checked before `duplicate_option_label`.

## Result

```ts
{
  content: [{ type: "text", text: string }], // envelope prose, or the decline message
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,       // option label, typed text, or null for multi
      selected?: string[],         // chosen labels, multi-select only
      notes?: string,              // free-text note, when you wrote one
      preview?: string,            // echoed when the chosen option carried a preview
    }>,
    cancelled: boolean,
    globalNote?: string,           // Submit-tab note. Present even when cancelled is true
    unansweredNotes?: Array<{      // notes on questions that were never answered
      questionIndex: number,
      question: string,
      note: string,
    }>,
    error?: QuestionnaireError,    // one of the codes above
  }
}
```

`globalNote` and `unansweredNotes` use a conditional spread. The key only appears when the value is non-empty. A result with no notes has no such key at all, so `!("globalNote" in result)` holds.

### Envelope text

On success the text reads `User has answered your questions: "<question>"="<answer>". … You can now continue with the user's answers in mind.` A chosen option's `preview` is added as `selected preview: <markdown>`, a per-question note as `user notes: <text>`, a note on an unanswered question as `note on "<question>": <text>.`, and the Submit tab's global note as a trailing `global note: <text>.` segment. A global note alone, or a single `unansweredNotes` entry alone, still yields the answered envelope. It counts as an answer even when every question is blank.

Cancelling, and any result with no answer segments, no unanswered note segments, and no global note, both collapse to the single string `User declined to answer questions` so the model sees one clear signal. Partial submission is allowed: unanswered questions simply add no segment. A cancelled result always reads as the decline in text. Its notes, if any, survive only in `details.globalNote` and `details.unansweredNotes`.

When `error` is `timed_out`, the text is `Questionnaire timed out, the user did not respond within the configured timeout. The user never saw a decline; do NOT treat this as a rejection. Ask the questions as plain chat text instead or retry.` The details keep `cancelled: true` and `error: "timed_out"` alongside any notes or answers the user left.

## Events

The package emits one event on Pi's event bus, after validation passes and before the dialog shows. Import it from the `./events` subpath:

```ts
import {
  ASK_POPUP_PROMPT_EVENT,
  ASK_POPUP_BLOCKED_EVENT,
  type AskPopupPromptEventPayload,
  type AskPopupBlockedEventPayload,
} from "pi-ask-popup/events";
```

`ASK_POPUP_PROMPT_EVENT` channel is `pi-ask-popup:prompt`. Payload is `questions[].{ question, header, multiSelect, options[] }` where each option is `{ label, description, hasPreview }`. Preview content is not shipped, only `hasPreview: boolean`, so listeners that forward the event stay small.

`ASK_POPUP_BLOCKED_EVENT` channel is `pi-ask-popup:blocked`. Payload is `{ blocked: boolean }`. It brackets the wait, true when the questionnaire starts and false when it resolves, so status or footer extensions can show that the agent is waiting.

Both payloads are JSON-safe. Channel names are stable. Changes are append-only and optional, and any breaking change ships as a new channel rather than a version field.
