# pi-ask-popup

> Not published yet. The scaffold is in place; the dialog is being ported.

Let the model ask you instead of guessing. This Pi extension registers one tool,
`ask_user_question`, that opens a terminal dialog of up to four questions with
written-out options, and hands your choices back as structured data.

## What it will do

- **Typed options, not a wall of prose.** Each question carries 2-4 authored
  choices, and every choice explains what it means or what it costs you.
- **You can always answer in your own words.** A `Type something.` row is
  appended to every question and widens to the full pane while you type.
- **Compare artifacts, not labels.** An option can carry a markdown `preview`
  that renders in a bordered box beside the option list.
- **One interruption, not five.** Up to four questions arrive in a single tabbed
  dialog, and a Submit tab names anything still blank before you commit.
- **Notes on any answer, or on all of them.** `n` opens a note editor on any
  question tab, and on the Submit tab it writes one note covering everything.
- **Read the transcript behind it.** `Ctrl+]` collapses the dialog and brings it
  back with your answers intact.
- **A timeout that is not a decline.** Auto-dismiss returns a distinct
  `timed_out` result, so the model never mistakes a clock for a refusal.
- **Works outside the terminal.** RPC and ACP hosts such as Zed or the VS Code
  pendant walk the host's native dialogs instead.

## Requirements

- Node.js 22 or newer
- Pi Agent 0.80 or newer, with an interactive terminal or an RPC/ACP host
- A terminal at least 100 columns wide for side-by-side previews

No runtime dependencies, no build step, no API keys. The extension makes no
model calls of its own.

## Credits

Derived from [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
by juicesharp, MIT licensed. This fork strips the `rpiv-config` and `rpiv-i18n`
dependencies, targets Pi 0.80+, and adds a timeout.

If you want something smaller, [`pi-ask-user`](https://www.npmjs.com/package/pi-ask-user)
by Enzo Lucchesi does a comparable job in a fraction of the code, with a
searchable split-pane selector instead of tabs and previews. Pick whichever fits.

## License

MIT. See [LICENSE](LICENSE) for both copyright holders.
