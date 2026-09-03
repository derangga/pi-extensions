# Keyboard and dialog layout

Every key the questionnaire dialog reacts to, the rows it adds for you, and how it adapts to the size of your terminal.

## Keys

| Key | What it does | Where it applies |
| --- | --- | --- |
| `Up` / `Down` | Move between rows. Wraps at both ends. | Option list, Submit picker |
| `Enter` | Confirm the focused option, commit typed text, close notes, or activate the focused Submit picker row. | Everywhere |
| `Shift+Enter` | Insert a newline. | `Type something.` input, notes editor |
| `Esc` | Cancel the whole questionnaire. | Everywhere except the notes editor, where it closes notes |
| `Tab` / `Shift+Tab` | Next and previous tab, wrapping. `Right` / `Left` do the same. | Multi-question dialogs only |
| `Space` | Toggle the focused checkbox. | Multi-select questions |
| `n` | Open the notes editor for the focused question, or on the Submit tab the global note for the whole questionnaire. | Every question tab, and the Submit tab in multi-question dialogs |
| `Ctrl+G` | Open Pi's configured external editor with the current custom answer draft. | `Type something.` input |
| `Ctrl+U` | Clear the current custom answer draft. | `Type something.` input |
| `Ctrl+]` | Collapse or expand the dialog. Configurable with `collapseKey`. | Everywhere, including while collapsed |

The table names the default keys. The dialog follows your Pi keybindings. Confirm listens to both `tui.select.confirm` and `tui.input.submit`, and a key bound to `tui.input.newLine` always inserts a newline even if it also matches confirm. So a Slack-style setup where `Enter` is mapped to `tui.input.newLine` and submit moved to `Ctrl+Enter` still works: `Enter` breaks lines, and your submit key confirms everywhere `Enter` does.

In a multi-select question, `Enter` on a regular row toggles its checkbox just like `Space`. It does not submit. Committing the question means focusing the `Next` row and pressing `Enter`. That is intentional: it makes `Enter` a cheap way to flip boxes without leaving the home row.

`Space` is blocked on two rows: `Next` is a command, not a choice, and `Type something.` is a text input where the space character belongs to your answer.

Timeout: if the call included a `timeout`, a live countdown shows in the footer and in the collapsed hint row, like `12s left`. The first keystroke you make cancels the timer. It does not reset, it stops.

## The rows the dialog adds

| Row | Label | Added to |
| --- | --- | --- |
| Custom answer | `Type something.` | Every question, single-select and multi-select, with or without previews |
| Commit | `Next` | Multi-select questions only |

Focusing `Type something.` turns the row into an inline multiline editor. In preview mode it expands to the full pane width while you type, so a long custom answer is not squeezed into the narrow options column. `Shift+Enter` inserts a line break. Vertical arrows move between lines and return to row navigation at the top and bottom of the draft. The draft replaces the static row label while you browse other options and is kept per question. `Ctrl+G` sends it through Pi's configured external editor and brings the result back. `Ctrl+U` clears it. `Esc` is the way to cancel the questionnaire. Confirming the row produces an answer of `kind: "custom"`.

Both labels are reserved. The model cannot use them as option labels. The check always compares against the English strings.

## Notes

`n` opens a notes editor on any question tab, whether the question is single or multi-select and whether its options carry previews. Notes live in a side band keyed by tab index, not inside the answer, so writing a note does not mark a question as answered. The Submit tab still lists it as missing. The note joins the answer when you confirm it, and reaches the model as `user notes: <text>`.

On the Submit tab, `n` opens the global note editor instead. One note covers the whole questionnaire. It lives outside every answer, so it survives tab switches and never marks a question as answered. It reaches the model as `global note: <text>`, and submitting with nothing but a global note still returns an answered result rather than a decline.

Inside the editor, `Shift+Enter` inserts a newline, while `Esc` and `Enter` close it. Other keystrokes edit the buffer, so `n` types an `n`. Pasted line breaks are kept.

A note on a question you never answer is not lost. It is returned as `unansweredNotes` alongside `answers` and appears in the envelope as `note on "<question>": <text>.`

## Collapse mode

`Ctrl+]` gets the dialog out of the way. The overlay is marked hidden in Pi's overlay stack and shrinks to a single dim hint row, so the transcript it was covering becomes readable and chat scrolling resumes. Press the same key to bring the questionnaire back with your answers intact. The first time you collapse, Pi shows the key to press. That message names your configured key.

Because Pi sends no input to a hidden overlay, the collapse key is also captured at the raw terminal level. It only acts when the questionnaire is hidden or focused, so a different overlay on top of it, for example `/btw`, keeps its keystrokes.

While collapsed, every keystroke except cancel is ignored. You cannot change answers you cannot see.

The default `Ctrl+]` is free in Terminal.app, iTerm2, Warp, tmux, zellij, and screen. On layouts where `]` sits on the shifted layer, like Latin American `es-AR` or `es-MX`, set a different `collapseKey` or `"off"` to disable it. See [Configuration](./configuration.md) and [Troubleshooting in the README](../README.md).

## Layout

Options render in a vertical list. When any option in a single-select question carries a `preview`, the dialog splits into a side by side layout with the option list on the left and a bordered monospace preview box on the right. This only happens when both the terminal and the dialog pane are at least 100 columns wide. Below that, the preview stacks under the options instead.

When the dialog is taller than the terminal, the body scrolls between a sticky heading and a sticky footer, and an overflow indicator shows which direction is clipped: `Up` for content above, `Down` for content below, `Both` for both. The exact markers are `↑`, `↓`, and `↕`.

The footer hint line adapts to context. It drops the notes hint and adds the `Shift+Enter` newline hint whenever a text editor has focus, with `Ctrl+U` still at the far right for custom answers. It adds the tab hint only in multi-question dialogs. The Submit tab follows the same idea: its bottom hint row sits below the picker and carries an `n to add a note` part that gives way to the `Shift+Enter` hint while the global note editor is open. A committed note shows as a `Note` entry in the review list. `Ctrl+G` is Pi's global external editor shortcut and is not repeated there. On narrow terminals the right edge clips with `…` so the main hints stay visible.
