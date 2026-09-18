# Pi Secret Guard

**Rule**: One glob, plus the layer it came from. A rule denies; there is no allow rule.
_Avoid_: Pattern — the matcher has patterns of its own and they are a different thing.

**Layer**: One source of rules. Three exist: builtin, global, project.
_Avoid_: Config file — the project layer is skipped for an untrusted checkout, so a file on disk is not always a layer.

**Unguard**: A global-layer entry that removes a builtin rule. The rule stops existing.
_Avoid_: Allow, exception — nothing is being permitted, and no dialog appears where an unguarded rule used to be.

**Gate**: The `tool_call` check. Resolve the path, match the rules, ask the user.
_Avoid_: Sandbox — the shell walks straight out of this. Block — blocking is one outcome of the gate, not the gate.

**Harvest**: Reading a matched file's values into memory at session start so they can be redacted later.
_Avoid_: Load, index, scan.

**Needle**: One harvested value the redactor looks for, carrying the label that replaces it.
_Avoid_: Secret — that names the file as often as the value, and the two need separate words.

**Noise floor**: The length and stoplist rules that drop a harvested value before it ever becomes a needle.
_Avoid_: Blacklist, filter.

**Redact**: Replacing a needle with its placeholder in text on its way out of a tool.
_Avoid_: Scrub, mask, sanitize.

**Placeholder**: What replaces a needle. `[redacted: DB_PASS]`.
_Avoid_: Mask, stub.

**Burn**: Dropping a needle because the user approved seeing that file in full. Permanent for the session.
_Avoid_: Unredact, whitelist — a burned needle is gone from the list, not marked on it.

**Allow once**: Letting a single gated call through. Records nothing, so the next call on the same path asks again.
_Avoid_: Grant — pi-dir-permission's grants persist for a session, and nothing here does.

**Example suffix**: The file endings excluded from the gate and the harvest both, `.env.example` and its kin.
_Avoid_: Ignore list — a gitignore is a different set and mostly the opposite one.
