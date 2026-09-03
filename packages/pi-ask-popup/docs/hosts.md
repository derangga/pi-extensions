# Hosts and runtime behavior

Where the questionnaire renders, what it falls back to, and what happens when it cannot render at all.

## Three environments

| Environment | What the model sees | What you see |
| --- | --- | --- |
| Interactive terminal | `ask_user_question` in its tool list | The full tabbed TUI overlay |
| RPC or ACP host (VS Code pendant, Zed, Paseo) | `ask_user_question` in its tool list | A sequence of the host's own native select and input dialogs |
| Non-interactive run (no UI) | Nothing, the tool is removed | Nothing |

### Terminal attention

After UI availability and questionnaire validation succeed, the package sends one standard terminal BEL (`\x07`) just before the interactive wait begins. The signal goes to `stdout` only when `process.stdout.isTTY` is true, so redirected output and non-TTY RPC streams stay untouched. A TTY-backed RPC dialog walk receives the same signal as the TUI path.

The BEL is best effort. If the synchronous write fails, the questionnaire continues and the existing prompt and blocked lifecycle and result shape are unchanged. Your terminal decides whether the BEL is audible, visual, or ignored. No BEL is sent for missing UI, invalid questionnaires, or a failed TUI session load.

### Non-interactive runs

A `before_agent_start` hook checks `ctx.hasUI` before every turn. When there is no UI, `ask_user_question` is removed from the tool list so the model never sees a tool it cannot use. When UI comes back, the tool is restored. The check is idempotent and leaves sibling tools alone.

A second guard lives inside the tool handler. If a call somehow arrives without UI, it returns `error: "no_ui"` and the text `Error: UI not available (running in non-interactive mode)`.

### RPC and ACP hosts

RPC hosts report `hasUI: true` because Pi's dialog protocol works there, but custom terminal UI does not render. The package catches this two ways: hosts that advertise `ctx.mode === "rpc"` go straight to the dialog walk and skip the TUI import, and older RPC builds are caught by a fallback when custom UI resolves without rendering. Either path needs the host to expose both `select` and `input`.

The walk asks one question per dialog and returns the same result shape the TUI produces. Trade-offs that come with native dialogs:

- No side by side preview pane. Previews are folded into the dialog title instead, truncated at 600 characters each.
- No tab bar and no Submit review tab. One dialog per question, in order.
- No notes. Both note types, per-question `n` on a question tab and global `n` on the Submit tab, are terminal-only. The host's native `select` and `input` have no note field.
- Multi-select is a free-text input: type the option numbers, comma separated (`1,3`). Any token that is not a valid option index is treated as a typed custom answer, which is how the `Type something.` escape survives. An empty input commits an empty selection, matching `Next` with nothing checked.
- Closing any dialog cancels the whole questionnaire, the same as `Esc` in the TUI.

If the host can render neither custom UI nor dialogs, the call returns `error: "no_custom_ui"` with text telling the model the user never saw the questions and to ask them as plain chat text instead. This is not a decline.

### Timeout on any host

`timeout` is part of the tool params and is passed through to the RPC walk as `dialogOpts.timeout`. The host is expected to dismiss the dialogs after that time. The TUI path runs its own countdown and shows the remaining seconds in the footer. In both cases expiry returns `cancelled: true` with `error: "timed_out"`, not a decline. See [Tool schema](./tool-schema.md).

## Surfaces that depend on conditions

Some parts of the dialog only appear when the conditions are right:

| Surface | Appears when |
| --- | --- |
| Tab bar and Submit tab | The call carries more than one question |
| `Next` row | The question is multi-select |
| `Type something.` row | Always |
| Side by side preview | An option carries a `preview`, and terminal and pane are both at least 100 columns |
| Preview pane at all | Single-select questions only |
| Collapse shortcut | `collapseKey` is not `"off"` |
| Full overlay hide on collapse | The host also exposes raw terminal input, the only path that can reopen a hidden overlay. Without it, collapsing shrinks the dialog to a visible one-line row instead |
| Countdown | `timeout` was passed and no keystroke has cancelled it |

## Loading and startup cost

The dialog's render graph costs about 560 ms to import, so it is loaded lazily on the first tool call, not when the extension registers. To keep that first call fast and safe, the graph is also pre-warmed in the background two seconds after startup. The pre-warm timer is unref'd, so it never keeps a process alive, and a failed pre-warm is ignored. The first real call tries again and reports correctly.

The pre-warm exists for a specific failure. Pi's module loader registers a module in its graph cache before it runs, and does not remove it if running throws. If your package manager replaces the store while Pi is running, one failed import can poison the cache for the rest of the process. Running the graph early, while the paths Pi saw at boot still exist, keeps it in memory and avoids that.

When it does happen, you get a structured result rather than a raw `TypeError`:

| `error` | Meaning | Fix |
| --- | --- | --- |
| `session_load_failed` | The dialog module could not be imported. | Repair the install if needed, then restart Pi. |
| `stale_module_cache` | The module cache went stale after an earlier failed import. | Restart Pi. This cannot be fixed inside the running process. |

Both messages tell the model the questions were never shown and to ask them as plain chat text instead of treating the failure as a decline.
