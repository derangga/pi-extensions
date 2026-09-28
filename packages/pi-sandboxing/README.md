# pi-sandboxing

Pi extension that keeps configured secrets out of model-controlled file tools and shell commands. Strict mode also removes inherited credentials, hides the host filesystem, and denies network access. The package has no runtime dependencies.

## Threat model

The model and loaded skills are untrusted. Pi, installed extensions, and tool implementations are trusted. An extension runs inside Pi with the user's permissions, so this package cannot contain a malicious extension.

Strict mode provides this boundary:

- Pi file tools cannot read or modify configured secret paths.
- Shell commands cannot read configured workspace secrets that existed before the command, or the user's home directory.
- Shell commands receive an allowlisted environment with a synthetic `HOME`.
- Shell commands cannot use Internet, loopback, or other network connections.
- SSH agent, Docker, cloud CLI, and similar host sockets are not inherited or mounted. Existing Unix sockets inside mounted workspace and toolchain paths are masked.
- The workspace remains writable except for protected targets.

The redactor remains as backup protection. It is not the security boundary for shell execution.

## Install

```sh
pi install pi-sandboxing
```

macOS uses `/usr/bin/sandbox-exec`. Linux requires [Bubblewrap](https://github.com/containers/bubblewrap), normally installed as `bwrap`. If the backend is missing or the configuration cannot be parsed, strict mode blocks shell commands rather than running them without isolation.

Windows and other unsupported platforms still block protected file tools, but strict shell commands are unavailable.

## Strict shell

Strict mode is the default at every session start and reload. It applies to the model-callable `bash` tool and to `!` or `!!` commands typed inside Pi. The `powershell` tool is blocked because this package has no strict PowerShell backend.

Each command gets:

- The real workspace mounted read-write.
- Every existing protected file, directory, symlink target, and hard-link alias masked from the process.
- A private temporary directory and synthetic home directory.
- System libraries and allowlisted home toolchains discovered from `PATH`, mounted read-only. Non-system toolchain roots are scanned for protected targets and host sockets before mounting.
- A new environment containing only `PATH`, `HOME`, `TMPDIR`, `SHELL`, locale, terminal settings, and `CI`.
- No network namespace on Linux and a network-denying SBPL rule on macOS.

Protected targets are checked again before every command. Directory metadata caches unchanged trees, while entry changes trigger a full rescan. If discovery or profile generation fails, that command does not run. An unreadable nested directory is masked as a whole. A transient discovery failure while checking a file tool blocks that call but does not disable strict shell for the rest of the session.

Model-visible `!` output is buffered until the command exits so a secret split across output chunks cannot bypass redaction. Use a separate terminal when live progress is required.

Commands that need package downloads, remote Git access, project credentials, local servers, or the real home directory should run in a separate terminal.

## Protected file tools

`read`, `edit`, `write`, `grep`, `find`, `ffgrep`, `fffind`, and configured path tools are checked in Pi's `tool_call` hook. Matching calls are always denied. There is no approval dialog.

The check uses both the path as written and its canonical target. It refreshes hard-link aliases before every file-tool call, so a protected `.env` cannot be read through an ordinary filename linked to the same file. Pi's leading `@` path shorthand is normalized before matching.

Recursive content searches are denied when their root contains a protected target. `ls`, `find`, and `fffind` may list protected filenames, but they do not read file contents.

## Unrestricted shell

Run `/sandboxing` and choose `Use unrestricted shell` when a command must have normal host access. Pi requires this exact phrase:

```text
ENABLE UNRESTRICTED SHELL
```

Unrestricted shell commands regain the host filesystem, environment, sockets, and network. A persistent red status line remains visible. The mode lasts only for the current session. Reloading, starting, resuming, or forking a session restores strict mode.

Protected file tools remain denied, and output redaction remains active. Unrestricted shell is still capable of sending a secret directly over the network without printing it. The redactor cannot stop that.

## Redaction

At session start, the extension harvests values from rule-matching files inside the workspace. When those values appear in tool output or assistant text, it replaces them with labelled placeholders:

```text
DB_PASS=[redacted: DB_PASS]
```

Values shorter than eight characters, pure numbers, booleans, and common development words are ignored. Exact substring matching means transformed, split, encoded, or previously unknown values may not be caught.

`.env.example`, `.env.sample`, `.env.template`, `.env.dist`, and equivalent suffixes are excluded because they normally contain public example values.

User messages are not redacted. If the user pastes a credential into the conversation, the model already has it.

## Default rules

The built-in rules cover:

- `.env` and `.env.*`
- `*.pem` and `*.key`
- `id_rsa*` and `id_ed25519*`
- `credentials.json` and `service-account*.json`
- `.npmrc` and `.netrc`
- `~/.aws/`, `~/.ssh/`, `~/.gnupg/`, and Cargo credentials
- `~/.docker/`, `~/.kube/`, and `~/.azure/`
- `~/.config/gcloud/` and `~/.config/gh/`

Filename rules apply anywhere. Location rules resolve from the workspace or home directory.

## Configuration

The extension reads `pi-sandboxing.json` first from Pi's agent directory and then from the trusted workspace's `.pi/` directory.

| Key | Default | Meaning |
| --- | --- | --- |
| `rules` | `[]` | Additional globs to protect, harvest, and mask. |
| `unguard` | `[]` | Built-in globs to remove. Accepted only in global configuration. |
| `stoplist` | `[]` | Additional harvested values to treat as noise. |
| `gatedTools` | `{}` | Extra tool names mapped to the input field containing their path. |

The old `enabled` key is ignored with a warning. Shell relaxation is session-only through `/sandboxing`.

Both configuration layers may add protection. Only global configuration may remove a built-in rule. Pi reads workspace configuration only after the project is trusted.

```sh
mkdir -p ~/.pi/agent && cat > ~/.pi/agent/pi-sandboxing.json <<'EOF'
{ "rules": ["*.jks", "secrets/**"], "unguard": [".npmrc"] }
EOF
```

Run `/reload` after changing configuration. A malformed file leaves Pi running but blocks strict shell execution until fixed.

## `/sandboxing`

The command opens a menu with these actions:

- Show the active backend, rules, and redaction counts.
- Switch back to strict shell.
- Enable unrestricted shell after typed confirmation.

The command name is namespaced because Pi renames duplicate extension commands with numeric suffixes.

## Platform details

### macOS

The profile imports Apple's `bsd.sb` process baseline, then revokes broad file reads, file writes, and all network access. It grants reads to system and detected toolchain paths, grants workspace access, and denies protected targets after those grants. Access to the common Security and Trust daemon services is denied explicitly.

`sandbox-exec` is deprecated and undocumented. OS updates may break commands that need an unlisted service. Such failures stay closed rather than falling back to an unrestricted command.

### Linux

Bubblewrap creates new user, process, IPC, UTS, and network namespaces. It starts from an empty root, recreates merged `/usr` links such as `/bin` and `/lib64`, mounts system and toolchain paths read-only, and overlays protected files or directories. A small set of loader and identity files under `/etc` is mounted read-only instead of exposing the whole directory. User namespaces or a setuid Bubblewrap installation must be available.

## Limits

- Installed extensions and tool implementations remain trusted code.
- The model can read ordinary workspace source and send it through trusted network-capable tools. This package protects configured secrets, not the whole repository.
- A rule added after a session starts needs `/reload` before file tools use it.
- A strict command may create a new rule-matching file and read it during that same command. The file contains data produced by that already-running command; pre-existing matching files remain masked.
- Strict commands cannot use package registries, Git remotes, localhost servers, SSH agents, Docker, or cloud credential helpers.
- Toolchains found through `PATH` are exposed read-only. Home-directory entries are limited to known layouts for nvm, fnm, Volta, Bun, Cargo, Go, pnpm, `.local/bin`, and `~/bin`. Unknown home-directory entries are removed from strict `PATH`. Fixed system roots such as `/usr` and `/nix/store` are not recursively scanned for filename-only rules. Explicit absolute rules under those roots are still masked. A deliberately hostile executable already present there is outside this threat model.
- Redaction ignores short and transformed secrets and can over-match ordinary output.
- Pi may save the unredacted full form of truncated Bash output in a host temporary file. Later tool reads still pass through redaction, but the temporary copy remains until the host clears it.
- macOS uses a system baseline that permits some operating-system IPC needed to start ordinary programs. Known credential services are denied, but Apple does not document every service name.
