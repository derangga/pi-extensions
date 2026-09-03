# Configuration

Every setting this package reads, where the file lives, and what happens when a value is wrong.

## The config file

```text
pi-ask-popup.json
```

The file is optional. With no config at all, every setting takes its default. This package only reads the file. It never creates, writes, or changes it.

A complete example:

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "description": "Ask the user structured questions whenever requirements are ambiguous.",
    "promptSnippet": "Ask me before guessing on anything ambiguous",
    "promptGuidelines": [
      "Batch every clarifying question into one ask_user_question call.",
      "Put your recommended option first and suffix it with (Recommended)."
    ]
  }
}
```

## Where the file is looked up

Two layers. The project layer overrides the global layer. Guidance merges per field, so a workspace can pin one line without restating the rest.

| Layer | Path | When it is read |
| --- | --- | --- |
| Global | `~/.pi/agent/pi-ask-popup.json` | Always |
| Project | `<project>/.pi/pi-ask-popup.json` | Only when the workspace is trusted |

The global path follows `getAgentDir()` from Pi. If you set `PI_CODING_AGENT_DIR`, that directory is used instead of `~/.pi/agent`. `CONFIG_DIR_NAME` is `.pi`, so the project path is always `<project>/.pi/pi-ask-popup.json`.

Project trust matters. Pi asks you to trust a checkout before it runs code from it. The project config is only read when `ctx.isProjectTrusted()` is true. An untrusted checkout cannot change your keyboard shortcut or rewrite the instructions the model sees. Guidance is stricter: it is read from the global layer only, even in a trusted project. Guidance is text that goes into the model prompt, and a checked-in file should not be able to change what the agent is told.

If neither file exists, you get the defaults. That is the normal case, not an error.

## When the file is invalid

The loader never throws. It returns defaults and reports problems as warnings. The caller decides where warnings go. On RPC and JSON hosts the process is speaking a protocol on stdout, so a stray `console.warn` would break the stream. Warnings are shown with `ctx.ui.notify` on the first tool call instead.

| Problem | What happens |
| --- | --- |
| File does not exist | No warning. No overrides. |
| Cannot read the file (permission, is a directory) | Warning with the path and the system message. No overrides from that layer. |
| Invalid JSON | Warning with the path and the parser message. No overrides from that layer. |
| Valid JSON that is not an object (string, number, null, array) | Warning that the file is not an object. No overrides from that layer. |
| A single field has the wrong type | That field is dropped and the built-in default stays. No warning. One bad field should not block the rest. |

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog overlay. | `"ctrl+]"` |
| `guidance.description` | Full text of the tool description the model sees. Replaces the built-in default entirely. | built-in description |
| `guidance.promptSnippet` | One-line summary of the tool in the system prompt. | built-in snippet |
| `guidance.promptGuidelines` | List of usage guidelines given to the model. | 5 built-in guidelines |

### `collapseKey`

The value uses Pi's keybinding id format: zero or more distinct modifiers from `ctrl`, `shift`, `alt`, `super`, joined by `+`, followed by a base key. Values are trimmed and lowercased before matching.

The base key is either a single printable character from

```text
a-z 0-9 ` - = [ ] \ ; ' , . / ! @ # $ % ^ & * ( ) _ | ~ { } : < > ?
```

or one of the named keys `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `f1` through `f12`.

Examples that work: `"ctrl+]"`, `"alt+o"`, `"ctrl+shift+h"`, `"f9"`, `"ctrl+}"`.

Set `"off"` to disable the collapse shortcut. No raw terminal listener is registered in that case.

A spec that does not match the grammar is rejected and the default is used. This is strict on purpose. Pi's parser takes the last `+` part as the key and discards unknown parts, so a typo like `"ctr+]"` would otherwise silently capture every bare `]` you type.

The footer hint inside the dialog names whatever key you configure (`Alt+O to collapse` for `"alt+o"`), as does the collapsed one-line footer and the one-shot notification shown when the dialog is first hidden. With `"off"` the hint is removed.

### `guidance.description`, `guidance.promptSnippet`, and `guidance.promptGuidelines`

`guidance.description` replaces the entire built-in description Pi registers for the `ask_user_question` tool. There is no merging. It is used only when it is a non-empty string. Anything else falls back to the built-in default.

`guidance.promptSnippet` and `guidance.promptGuidelines` replace the text Pi puts in the system prompt about when to use `ask_user_question`. Use them to make the model ask more or less often, or to enforce a house style for options.

`promptSnippet` is used only when it is a non-empty string. `promptGuidelines` is used only when it is a non-empty array whose entries are all non-empty strings. Anything else falls back to the built-in defaults.

Guidance is read once, when the extension registers the tool, so changes take effect on the next Pi restart. This is the same for `collapseKey`, but that key is resolved on each tool call so it can pick up the project override.
