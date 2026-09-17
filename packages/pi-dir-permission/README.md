# pi-dir-permission

Pi extension. Confines the file tools to your working directory, and opens up anything outside it one dialog at a time. Zero runtime dependencies.

Pi ships no filesystem sandbox: `read`, `write`, `grep` and the rest resolve whatever absolute path they are handed, including `~/.ssh` and a sibling checkout you never mentioned. This extension is the boundary. The first time a tool reaches outside, you are asked once and the answer sticks for the session.

```
read wants /Users/you/neighbour-repo/src/server.ts, outside the allowed directories
  → Allow once, this call only
    Allow /Users/you/neighbour-repo/src for this session
    Allow /Users/you/neighbour-repo (whole repository) for this session
    Deny
```

## Install

```sh
pi install pi-dir-permission
```

The package declares no `dependencies`. It needs two host-provided peers that any Pi install already ships: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## Commands

| Command | What it does |
| --- | --- |
| `/dir-perm-add <path>` | Allows a directory for this session. `~` works. |
| `/dir-perm-add` | Opens the picker: type a path, Tab completes, Enter adds, Esc cancels. |
| `/dir-permissions` | Lists what is allowed; Enter on a row revokes it. |

Allowed directories show up in the status line as `📁 2 external dirs`, which Pi's footer renders, as does [pi-status-widget](../pi-status-widget).

The commands are namespaced on purpose. Pi resolves two extensions registering the same command name by renaming both to `/name:1` and `/name:2` without telling anyone, so a common name like `/dir-add` is a trap.

## What is inside the boundary

Before you allow anything: your working directory, the system temp directory, and Pi's own agent directory (`~/.pi/agent`). Refusing a scratch write to `/tmp` or a read of the agent's own state costs a dialog every session and buys nothing.

Grants live in the session, not on disk. They survive a reload, they follow a rewind — undo past the grant and it is gone — and they end when the session does. Nothing this extension does can outlive the reason you granted it.

Every comparison runs on resolved, symlink-followed paths, so a link inside the workspace pointing at `/etc` is caught rather than waved through.

## Which tools are gated

`read`, `edit`, `write`, `ls`, `grep`, `find`, all on their `path` argument.

Also [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff): `ffgrep`, `fffind` and `fff-multi-grep`. Its `path` argument accepts absolute, `~/` and `../` paths outside the workspace and searches them through a separate index, which is a way out that looks nothing like a file read. fff renames its tools to `grep`, `find` and `multi_grep` in override mode; both sets are covered, so no mode detection is needed. A repo-relative constraint like `src/**/*.ts` resolves to somewhere inside the workspace and passes untouched.

Any other tool, from any extension, can be added:

```json
{
  "gatedTools": { "some_tool": "file_path" }
}
```

## Configuration

`pi-dir-permission.json`, read from `~/.pi/agent/` and then from the workspace's `.pi/`, which overrides it. Every key is optional, and the workspace layer is read only for a trusted project — an untrusted checkout must not be able to widen its own boundary.

| Key | Default | Meaning |
| --- | --- | --- |
| `iconMode` | `"emoji"` | `"emoji"` for 📁, `"nerd"` for the Nerd Font folder glyph (U+F07B, nf-fa-folder). |
| `icon` | — | Any string, replacing the icon for either mode. |
| `gatedTools` | `{}` | Extra tool names mapped to the argument holding their path. |

There is no settings menu. Switching the status line to a Nerd Font glyph is one file, globally:

```sh
mkdir -p ~/.pi/agent && echo '{"iconMode": "nerd"}' > ~/.pi/agent/pi-dir-permission.json
```

Or for this workspace only, which overrides the global file:

```sh
mkdir -p .pi && echo '{"iconMode": "nerd"}' > .pi/pi-dir-permission.json
```

Then `/reload`. Pi re-emits `session_start` on reload, which is when the config is read, so there is no need to restart the session.

If your font puts something other than a folder at U+F07B, `{"iconMode": "nerd", "icon": ""}` wins over both modes. JSON `\uXXXX` escapes work here, so an invisible glyph never has to be pasted into the file.

## Limits

**`bash` and `powershell` are not gated.** A shell command is a string, and picking paths out of one is guesswork that blocks harmless commands while still missing `cd .. && cat`. `cat /etc/passwd` works. This is a workspace boundary that keeps the agent from wandering, not a security boundary that contains a hostile one.

**fff's index is not policed.** The gate controls what fff is asked to search, not what it has already indexed.

**Blocked calls queue their dialogs.** Three refusals in one batch means three prompts in a row.

**A grant covers reads and writes alike.** Allowing a repository root makes that repository as writable as your own project, so allow the directory rather than the repository when the errand is one file.

**Headless runs deny.** In RPC, JSON and print mode there is nobody to ask, so an outside path is refused with a reason naming `/dir-perm-add`. A boundary that opens itself when unattended is not a boundary.
