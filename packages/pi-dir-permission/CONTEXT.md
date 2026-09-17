# Pi Dir Permission

**Boundary**: The set of directories the file tools may touch. The baseline (workspace, temp directory, Pi's agent directory) plus every grant.
_Avoid_: Sandbox, jail — the shell walks straight out of this one.

**Grant**: One directory the user allowed for this session, stored as a custom session entry and replayed from the branch.
_Avoid_: Permission record on disk, setting, config entry.

**Baseline root**: A directory inside the boundary before anything is granted. Three of them, fixed in code, not configurable.
_Avoid_: Default grant.

**Gated tool**: A tool whose named argument is resolved and checked before it runs. The six built-ins, fff's three, plus anything in `gatedTools`.
_Avoid_: Blocked tool — gating is the check, blocking is one outcome of it.

**Grant scope**: The directory offered in the block dialog. Either the directory the path names, or the git repository above it.
_Avoid_: Path, target — the target is what the tool asked for, the scope is what the user would open up.

**Allow once**: Letting a single call through without recording anything. Leaves the boundary exactly as it was.
_Avoid_: Temporary grant — nothing is stored, so there is nothing to expire.
