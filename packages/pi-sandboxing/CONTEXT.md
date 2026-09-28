# Pi Sandboxing

**Rule**: One glob plus the layer it came from. A rule protects matching paths.
_Avoid_: Pattern. The matcher has patterns of its own, and they are a different thing.

**Layer**: One source of rules. Three exist: builtin, global, project.
_Avoid_: Config file. The project layer is skipped for an untrusted checkout, so a file on disk is not always a layer.

**Unguard**: A global-layer entry that removes a builtin rule.
_Avoid_: Allow, exception. No access decision occurs when an unguarded rule stops existing.

**Gate**: The `tool_call` check on Pi's in-process file tools. It resolves the lexical and canonical path, checks known aliases, and denies a protected call.
_Avoid_: Dialog. Strict protection has no approval path.

**Strict shell**: Model and user shell commands running under the OS backend with a minimal environment, synthetic home, protected targets, and no network.
_Avoid_: Safe shell. It protects configured secrets, not every piece of workspace data.

**Unrestricted shell**: Session-only shell execution with normal host filesystem, environment, socket, and network access. Protected file tools and redaction remain active.
_Avoid_: Disabled sandboxing. Two protections remain enabled.

**Jail**: One immutable OS profile and its private directories for a single command.
_Avoid_: Gate. The jail operates below Pi's file tools.

**Backend**: The OS mechanism that enforces a jail. `sandbox-exec` on macOS, Bubblewrap on Linux.
_Avoid_: Platform. A platform may have no usable backend and fail closed.

**Protected target**: An existing path masked or denied in strict shell, including canonical targets and hard-link aliases.
_Avoid_: Rule. A rule can produce several protected targets.

**Synthetic home**: A private empty directory assigned to `$HOME` inside a strict command.
_Avoid_: Fake home. It is a real writable directory with command scope.

**Harvest**: Reading a matched workspace file's values into memory so later output can be redacted.
_Avoid_: Load, index, scan.

**Needle**: One harvested value and the label that replaces it.
_Avoid_: Secret. That word also names files and locations.

**Noise floor**: The length and stoplist rules that drop a harvested value before it becomes a needle.
_Avoid_: Blacklist, filter.

**Redact**: Replace a needle in tool output or assistant text with its placeholder.
_Avoid_: Sanitize. Redaction is exact substring replacement, not proof that output is safe.

**Placeholder**: The text replacing a needle, such as `[redacted: DB_PASS]`.
_Avoid_: Mask, stub.

**Example suffix**: A public fixture suffix excluded from built-in protection, such as `.example`, `.sample`, `.template`, or `.dist`. A configured rule can still protect it.
_Avoid_: Ignore list. A gitignore is a separate set with a different purpose.
