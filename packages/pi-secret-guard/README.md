# pi-secret-guard

Pi extension. Asks before a tool reads your `.env`, and keeps the values out of the model's context when something reads it anyway. Zero runtime dependencies.

Pi ships no filesystem sandbox, so `read`, `grep` and `bash` resolve whatever they are handed. A deny list on its own would be theatre: the model asks for `.env` once, gets refused, and then runs `cat .env`, or `grep -r password .`, or `node -e 'console.log(process.env.DB_PASS)'`. Three routes, one of them gated.

So this extension is two halves. A gate that asks, and a redactor that means it.

```
read wants /Users/you/app/.env, which is gated
  → Allow once, this call only
    Deny
```

Deny, and the model is told to ask you instead. Allow, and it sees the file in full. Do neither, and any secret value that surfaces later reads like this:

```
$ cat .env
DB_PASS=[redacted: DB_PASS]
PORT=3000
```

## Install

```sh
pi install pi-secret-guard
```

The package declares no `dependencies`. It needs two host-provided peers that any Pi install already ships: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## How the two halves work

**The gate** runs on `tool_call`. It resolves the path argument of `read`, `edit`, `write`, `grep` and `find`, matches it against the rules, and asks. For `bash` and `powershell` it scans the command's tokens instead, which catches `cat .env` and loses to `cat $(echo .env)`.

**The redactor** runs on `tool_result`, on `user_bash`, and on the model's own finalized messages. At session start every rule-matching file inside your working directory is harvested: its values go into a list of needles, each with a label taken from the key where the format has one. Anything leaving a tool gets those needles replaced by their placeholders.

The two halves meet in one place. Approving a read burns that file's needles before the tool runs, so the redactor handles the approved call by finding nothing left to do. No shared state, no call bookkeeping, one set of strings.

A burned needle stays burned for the session. Once the model holds a value, redacting its echo protects nothing and leaves a transcript where the file shows a password and the sentence about the file shows a placeholder.

Your own typing is never redacted. Handing the agent a credential on purpose stays possible.

## What is gated by default

`.env` and `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `credentials.json`, `service-account*.json`, `.npmrc`, `.netrc`, and the directories `~/.aws`, `~/.ssh`, `~/.gnupg`.

Excluded from the gate and the harvest both: `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, and anything ending `.example` or `.template`. These are committed files full of fake values, and harvesting them would turn `changeme` into a needle that redacts half your output.

Only files inside your working directory are harvested. `~/.ssh` is gated by path and never read: loading every credential you own into a Node process to protect them is the wrong trade, and [pi-dir-permission](../pi-dir-permission) already blocks paths outside the workspace.

`ls` is not gated. A listing that shows `.env` exists leaks nothing.

## Configuration

`pi-secret-guard.json`, read from `~/.pi/agent/` and then from the workspace's `.pi/`. Every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the whole extension off. |
| `rules` | `[]` | Extra globs to gate and harvest. Added to the builtins. |
| `unguard` | `[]` | Builtin globs to remove. Honoured in the global file only. |
| `stoplist` | `[]` | Extra values to treat as noise. Added to the builtins. |
| `gatedTools` | `{}` | Extra tool names mapped to the argument holding their path. |

Both layers can add rules. Only the global file can take one away, and the workspace layer is read only for a trusted project, so a repository you just cloned cannot un-gate itself by shipping a `.pi/pi-secret-guard.json`.

```sh
mkdir -p ~/.pi/agent && cat > ~/.pi/agent/pi-secret-guard.json <<'EOF'
{ "rules": ["*.jks", "secrets/**"], "unguard": [".npmrc"] }
EOF
```

Then `/reload`. Pi re-emits `session_start`, which is when rules are read and files are harvested.

## Commands

| Command | What it does |
| --- | --- |
| `/secret-guard` | Shows the active rules, how many needles are loaded, and what has been redacted or burned this session. |

There is no command to allow a path, because there is nothing to record: every gated call asks again. There is no flag and no hotkey to turn the guard off either. A guard with a toggle is a guard that gets switched off at 2am and stays off, so switching it off is a deliberate edit to the config file.

The command name is namespaced on purpose. Pi resolves two extensions registering the same name by renaming both to `/name:1` and `/name:2` without telling anyone.

## Limits

**This is a leak filter, not a sandbox.** The shell can copy a secret somewhere the redactor never looks: `cp .env /tmp/x` prompts on the token scan, `tar czf /tmp/x.tgz .` does not. Nothing here contains a hostile agent. It keeps an ordinary one from pasting your database password into a pull request.

**A secret under 8 characters passes through.** Nothing can tell a short password from a port number, and redacting every 4-character string would eat your output.

**Approving a read is permanent.** The value lands in the session file on disk and is resent with every following turn. What the model sees and what Pi persists are one object, so this cannot be softened.

**`bash` spills truncated output to a file.** Pi writes the full text to a temp path when output is long, and that copy is not redacted. Nothing reaches the model through it, since any read of that file passes through the redactor, but the copy exists until your temp directory is cleared.

**Redaction over-matches.** Needles are plain substrings, longest first, so a value that happens to appear inside unrelated text takes the placeholder with it. Over-matching is the safe direction: a mangled log line costs a squint, a missed secret costs the secret.

**Headless runs allow the call.** In RPC, JSON and print mode there is nobody to ask, so a gated read proceeds and the redactor covers it. The gate exists for your attention, and unattended there is none to interrupt. This is the opposite of pi-dir-permission's choice, which denies, because that extension has no second line of defence.

**Two dialogs are possible.** A read of `~/.ssh/id_rsa` is outside the workspace and matches a rule, so with pi-dir-permission installed you are asked twice. Either refusal blocks the call, so the answer is never wrong, only repetitive.
