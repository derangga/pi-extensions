# pi-subagent: the design, and why

Decision record for the `pi-subagent` package. Written before the code, so the
reasoning survives it.

Companion to the three documents that produced it:
[`pi-core-subagent.md`](./pi-core-subagent.md),
[`pi-subagents.md`](./pi-subagents.md) and
[`subagent-comparison.md`](./subagent-comparison.md). Those describe the two
existing subagent extensions, both vendored in this repo. This one describes
what to build instead, and every decision here was made against something one
of them actually does.

## The shape

One tool call takes a batch of tasks, each with an optional list of the tasks it
needs. No edges means plain parallel. An edge does two things: it gates the
dependent until its upstream settles, and it prepends the upstream's output into
the dependent's prompt. The orchestrator never copies a result between tasks, so
it cannot forget to.

Children are read-only. A child gets pi's `read`, `grep`, `find` and `ls` plus
fff, and no other extension loads at all. The user picks the subagent model and
thinking effort from `/subagent settings`, and that choice outranks the model's
own per-task pick.

Target: under 2,500 source lines. pi-core-subagent is 3,300 with worktrees;
pi-subagents is 21,000.

## Decisions

### Dependency

**Effect v4 core is the single runtime dependency.** The repo rule moved from
zero dependencies to fewest, and `AGENTS.md` now says so. The count is pinned by
each package's manifest test, so a second one fails the suite rather than
arriving unnoticed.

**Core only, not the platform packages.** `effect/Schema` is in core, so the
settings file gets a real decoder without a second package. `node:fs` and
`pi.exec` cover the rest, and `pi.exec` is required anyway for anything pi
should see.

**typebox stays a peer.** `registerTool` takes a typebox `TSchema`. This is not
negotiable by the dependency choice, and it must be `typebox` v1 rather than
`@sinclair/typebox`, which is a different package pi never loads.

**Effect reaches the tool boundary and stops.** Services, Layers and Scope for
the manager, the runs and the latches. One `ManagedRuntime` built at activation,
and each tool `execute` bridges with `runPromise`. TUI components stay plain
classes, because pi's `Component` contract is a synchronous `render(width)` that
repaints several times a second and wrapping it buys nothing.

### What a child is

**Read-only.** No `bash`, `edit` or `write`, therefore no worktrees, no
branches, no crash-recovery sweep and no merge story. This is the single largest
cut in the design: pi-core-subagent spends 366 lines on worktrees plus an
owner-file scheme for reaping them after a crash, and pi-subagents spends
another 200.

**Exactly one extension loads in a child: `@ff-labs/pi-fff`.** Through
`noExtensions: true` plus `additionalExtensionPaths`, which combine (see
[facts](#facts-about-pi-that-shaped-this)). Loading everything and filtering
would be worse, because `extensionsOverride` runs after every factory has
already executed, so filtering suppresses tools and bound handlers but not
load-time side effects.

**Nesting is impossible by construction**, because this extension is never in a
child's extension set. Keep the AsyncLocalStorage re-entry guard anyway, at
fifteen lines. The failure it prevents is a second manager with leaked handlers,
which is silent and permanent.

**Standalone system prompt.** pi's base layers, then the inline prompt the
orchestrator wrote, then the subagent instruction block. The parent's prompt is
not inherited, and there is no `inherit_context`. A research child does not need
the parent's coding conventions, and inheriting costs real input tokens on every
child.

**Sessions are persisted and nested under the parent**, so `/resume` sees them
and each has a file path to tail. That path is what replaces the peek pane.

### Delegation

**A batch with optional edges, not one agent per call.** Ordering is in the
schema from the start, because changing a tool schema later means the
orchestrating model has to relearn it, and that is the expensive kind of change.
One wave scheduler covers single, parallel and chain: they are three shapes of
the same loop, not three code paths.

**The model invents the agent per call.** A user `.md` file applies only when
addressed by exact name. No catalog, so no per-request context cost.
pi-subagents' agent-type registry costs roughly 1,400 tokens of parent context
with only three agents.

Description matching is rejected. pi-core-subagent's version is a two-token,
40 percent coverage threshold over crude stemming, which surprises people both
when it fires and when it does not, and there is no way to say "use this exact
file".

**Four parent tools**: `subagent`, `subagent_result`, `reply_subagent`,
`subagent_cancel`. Status merges into result because a dead-on-spawn failure is
delivered as an interrupting steer, which is what a separate status tool was
compensating for in pi-core-subagent.

**`ask_parent` and `notify_parent`, no sibling mailbox.** The parent channel is
the capability pi-subagents lacks entirely, and a child that can ask one
question is worth more than a child with three more configuration flags. The
sibling mailbox is cut because `needs` edges already carry ordered
coordination, and same-wave siblings are independent by construction.

**Parked delivery while the parent waits.** A parent blocked inside a waiting
call should not have to stop blocking to learn its child asked a question. Child
traffic is collected and returned inside that tool result, and when the queue is
full an ask displaces the oldest non-ask so a blocking question is never dropped
for a status update.

### Control

**Precedence for model and thinking effort**, highest first:

1. The agent file, most specific and user-authored.
2. `/subagent settings`, user-authored and global.
3. The per-task field in the tool call, the orchestrator's runtime guess.
4. The parent's model.

Both user sources outrank the model's runtime choice, and the more specific user
source wins. The setting ships as `inherit`, so the per-task field still works
until the user names something concrete. That is what keeps "one task in this
batch is trivial, run it on haiku" available without giving up the guarantee
that a concrete setting holds.

**Thinking levels come from pi-ai's own `getSupportedThinkingLevels(model)`.**
Do not hand-roll it; the rule is subtler than it looks (see
[facts](#facts-about-pi-that-shaped-this)).

**Validate before any fiber forks, and read back afterwards.** Every task's
model and level pair is checked before the run exists, so an unsupported pair
fails the call naming the task with zero children spawned. Then also read
`session.thinkingLevel` back and surface it when it differs from the request.
Validation covers what `thinkingLevelMap` describes; reading back covers
whatever it does not, including a future pi that clamps for a reason the map
never mentioned. Re-validate after any model fallback, which is the case both
halves miss alone.

**Turn limit primary, wall clock as backstop.** 30 turns with 5 grace turns,
then abort, plus a 30 minute wall-clock bound. Both reference extensions default
turns to unlimited, which leaves the clock doing all the work and lets a broken
tool loop burn for hours. The graceful sequence (steer to wrap up, then grace,
then abort) produces a usable partial answer instead of a truncation.

Outcomes are distinct because the parent should act differently on each:
completed, wrapped up at the limit, aborted after grace, timed out, stopped by
the user, failed.

### Accounting

**Two token totals from one accumulator.** The display total is
`input + output + cacheWrite`. The billing total adds `cacheRead`. Each turn's
`cacheRead` is the cumulative cached prefix re-read on that one call, so summing
it across turns overstates work done while stating the bill correctly. Both are
real answers to different questions. pi-core-subagent keeps only the billing
figure and renders it as a work figure.

**Accumulate from `message_end`, never from `getSessionStats()`.** Session stats
derive from the message array that compaction replaces, so a stats-derived sum
resets every time a child compacts.

**The parent session's own totals stay untouched.** A delegating session will
read as cheaper than it was. Pushing spend into `/cost` is additive later, and
changes no schema.

### Surfaces

**Widget plus tool rendering, no peek pane.** An above-editor widget throttled
to roughly one render per 150ms, plus `renderCall` drawing the graph while the
model is still typing the call and `renderResult` for the summary. The wave line
is omitted entirely when no task has edges, so flat work renders flat and the
graph vocabulary is not imposed on work that has no graph.

**Three events on the bus**: run started, task settled, run settled. Enough for
`pi-statusbar` or anything else to render run state without importing this
package. No RPC and no spawn-from-outside surface until something asks.

## What was cut

Each of these was considered against a working implementation and rejected, so
none of them should be re-argued without new information.

| Cut | Because |
|---|---|
| Write agents and worktrees | The largest single body of code in either reference. Read-only children need none of it |
| Nested spawning | Free to prevent, and it is a privilege boundary that pi-subagents documents as its own main risk |
| Scheduling | A whole dependency (`croner`) and a locked store, for a feature nobody asked for here |
| Scripted workflow sandbox | A `vm`-on-worker-thread with a determinism prelude. `needs` edges cover ordering |
| Handle-based addressing | Tombstones, a name allocator and an off-screen conversation clone |
| Cross-extension RPC | No caller exists. Three events cover the one plausible consumer |
| Structured output | pi does not plumb `toolChoice` through `AgentSession`, so it cannot be forced, only asked for |
| Parent conversation inheritance | Costs input tokens per child and is never refreshed. A research child rarely needs it |
| Sidecar run history | Display-only state that is never resumed from |
| Peek pane | 273 lines of TUI. `subagent_result` returns the session paths and `tail` covers it |

## Facts about pi that shaped this

Expensive to rediscover, so recorded here. All verified against the installed
packages rather than the typings alone.

**`noExtensions` and `additionalExtensionPaths` combine.** They resolve through
separate code paths, and the flag only drops the discovered set:

```js
const extensionPaths = this.noExtensions
    ? cliEnabledExtensions
    : this.mergePaths(cliEnabledExtensions, enabledExtensions);
```

So a child can be handed exactly one extension and nothing else. This is what
makes both the fff decision and the no-nesting guarantee cheap.

**`extensionsOverride` runs after every factory has executed.** Filtering an
extension out of the loaded set suppresses its tools and its bound lifecycle
handlers, but not its load-time side effects. It is not a sandbox.

**pi has no MCP client.** `@earendil-works/pi-coding-agent` has zero mentions of
MCP in its public type surface. On pi, fff is `@ff-labs/pi-fff`, a native
extension calling `registerTool` directly. The MCP server of the same name is a
Claude Code arrangement and does not apply here.

**fff registers its tools lazily**, from `session_start` with a
`before_agent_start` fallback, not at factory time. pi's `allowedToolNames` gate
is frozen at construction and a name absent from it is dropped forever, even
once the tool actually registers. So the allowlist must name fff's tools up
front. There are six across all modes: `ffgrep`, `fffind`, `fff-multi-grep` in
the default and tools-only modes, and `grep`, `find`, `multi_grep` in override
mode, where it deliberately shadows pi's built-ins.

**`getSupportedThinkingLevels` is not what a naive reading suggests:**

```js
if (!model.reasoning) return ["off"];
return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
});
```

A missing key means "use the provider default", so `minimal` through `high` are
opt-out. But `xhigh` and `max` are opt-in, and a missing key excludes them.
`reasoning: false` collapses everything to `["off"]` regardless of the map. A
reasoning model with no map at all supports `off, minimal, low, medium, high`.
Note also that `ThinkingLevel` does not include `"off"`; that is
`ModelThinkingLevel`.

**Emit `session_shutdown` before disposing a child session.** pi emits it in its
own dispose path, and binding extensions onto a session directly is one of the
few places that bypasses that path. Without the emit, everything a child
extension armed in `session_start` leaks once per spawn. fff starts an interval
status poll under some conditions, which makes this concrete rather than
theoretical.

**`sendUserMessage`'s `deliverAs` is `"steer" | "followUp"`.** `sendMessage`
additionally takes `"nextTurn"`. The interrupting startup-failure notice uses
`"steer"`.

## The known risk

Read-only children plus dependency edges can only ever chain research into
synthesis. A plan-then-implement chain is not expressible here, because the
implementer would need write tools.

If that turns out to be what this is wanted for, write agents come back, and
they bring worktrees with them: creation, commit, diff, branch naming, and a
crash-recovery sweep for worktrees a dead process left behind. They also bring
the one idea from pi-core-subagent worth copying wholesale, which is stacking a
dependent's branch on its upstream's. Without stacking, a downstream child
writes code against a name its upstream renamed, and the merge succeeds with
exit 0 while leaving a tree that does not compile.

That is a re-open, not an extension. It roughly doubles the package.
