# Two ways to build subagents in pi: what to copy and what to skip

Companion to [`pi-core-subagent.md`](./pi-core-subagent.md) and
[`pi-subagents.md`](./pi-subagents.md), which describe each extension on its own
terms. This one puts them side by side and answers the question behind the
reading: if you are building a third one, with no dependencies, where the user
picks the model and sets the thinking effort, what should you take from each?

## The one-paragraph version

`@arhen/pi-core-subagent` is a delegation *primitive*. It is 3,300 lines, has
zero dependencies, exposes 7 tools, and bets everything on one idea: a task is a
dependency graph, and an edge both gates a task and hands it its input. It
refuses features that would dilute that.

`@tintinweb/pi-subagents` is a delegation *product*. It is 21,000 lines, has 4
dependencies, and reproduces Claude Code's subagent surface in pi, then adds a
sandboxed script orchestrator, a scheduler, cross-extension RPC, nested
delegation, `@handle` addressing, and 24 persisted settings. Almost every
paragraph of its source names a specific failure it is defending against.

Neither is wrong. They are answers to different questions.

## At a glance

| | pi-core-subagent | pi-subagents |
|---|---|---|
| Version read | 1.3.52 | 0.19.0 |
| `src/` size | ~3,300 lines, 12 files | ~21,000 lines, 58 files |
| Runtime deps | 0 | 4 |
| Parent tools | 7 | 4 |
| Child tools | 4, always on | 3, opt-in per agent |
| Orchestration | wave scheduler over `needs` edges | one spawn per call, plus a JS script runtime |
| Agent definition | inline per call, or a matched file | agent type files, resolved by name |
| Agent file lookup | by `description` token overlap | by `name` / filename |
| Turn limits | none | soft steer, grace turns, hard abort |
| Wall-clock limits | 1 h or 6 h ceiling | none |
| Nesting | refused by construction | opt-in, depth-capped |
| Context inheritance | no | `inherit_context`, plus session cloning for mentions |
| Structured output | deliberately refused | `StructuredOutput` tool with constrained sampling |
| Usage into parent `/cost` | no | opt-in `reportUsage` |
| Persistence | sidecar JSON, display only | real pi sessions plus tombstones for `@handle` |
| Settings | one boolean | 24 fields, two files |
| Cross-extension API | events only | 4 RPC channels plus a global registry |

## Context management

Both get the fundamental right: a child is a separate `AgentSession` in the same
process, so spawning is instant and the child's transcript never enters the
parent's context. Only the final text comes back.

Where they differ is how much *parent* context a child can be given, and how
much *parent* context the tooling itself costs.

### What a child starts with

| | pi-core-subagent | pi-subagents |
|---|---|---|
| Base prompt | pi's own layers, plus an appended block | either pi's parent prompt verbatim (`append`) or a fully replaced prompt (`replace`) |
| Extensions in the child | never (`noExtensions: true`) | `true` / `false` / list, with an exclude denylist and `ext:` tool selectors |
| Parent conversation | not available | `inherit_context` renders it as a prompt prefix |
| Project files (`AGENTS.md`) | via pi's loader | suppressed in `replace` mode, inherited in `append` mode |
| Skills | via pi's loader | inherit all, none, or preload a named list into the prompt |
| Memory | none | three scopes with a `MEMORY.md` index |

`pi-subagents`' `append` mode is worth studying even if you build nothing like
it. It places the parent's system prompt first, verbatim and unwrapped, so the
child's prompt shares an identical byte prefix with the parent session and the
provider's KV cache can reuse those tokens across every spawn. The per-call
parts come after. That is a free win available to any implementation that
inherits a parent prompt, and getting the order wrong throws it away silently.

`inherit_context` is the weaker of the two mechanisms it offers. It is a text
rendering of the conversation (`[User]: …` / `[Assistant]: …`, tool results
dropped, compaction summaries kept) prepended to the child's first user message.
It costs input tokens once and never refreshes. The mention path does the better
thing: a real in-memory clone of the parent session, entries and system prompt
included, compaction-aware. If you need context inheritance, clone the session
rather than stringifying it.

### What the parent pays

This is where the primitive wins outright.

`pi-core-subagent` injects nothing per request. No agent catalog, no context
hook. The parent-side cost is 7 tool schemas with short descriptions, and the
child prompt assembly happens inside the child.

`pi-subagents`' `Agent` tool description is around 1,400 tokens in `full` mode
with the default agents, because it enumerates every available agent type with
its description and tool scope. That is the price of letting the model route
work to the right specialist. The extension acknowledges it and offers
`compact` (about 75% smaller) and `custom` (your own file, with placeholders so
the dynamic type list stays live).

For a new extension the lesson is: the type list is the expensive part of an
agent-catalog design. If the model invents the agent per call, as
`pi-core-subagent` does, there is no list to advertise and the cost collapses.
The tradeoff is that the model must write a good system prompt each time, and
the user's own agent files are then reached by description matching rather than
by name.

### What comes back

| | pi-core-subagent | pi-subagents |
|---|---|---|
| Cap on the returned text | 24 KiB, byte-measured, with a pointer to the session file | none on the full result |
| Background completion payload | task notice with a 200-char detail | 500-char preview in the notification |
| Group completion payload | not applicable | 300-char preview per agent |
| Full text | `subagent_result` | `get_subagent_result` |

The 24 KiB cap is a real design decision, not a detail. It bounds the worst
case: a child that returns its whole findings dump cannot blow up the parent's
context in one tool result. `pi-subagents` bounds only the notification preview,
so a `get_subagent_result` on a verbose agent can be arbitrarily large.

### Compaction

Only `pi-subagents` treats a child's compaction as an event worth reporting. It
counts compactions per agent, surfaces the count as `⇊2` in the widget, emits
`subagents:compacted` with the reason and pre-compaction size, and re-anchors
its transcript writer afterwards.

The re-anchoring bug it fixed is one any implementation streaming a transcript
will hit: compaction replaces `session.messages` with a shorter array, leaving a
write cursor past the end, and streaming halts permanently with no error. If you
stream messages by index, you need this.

`pi-core-subagent` neither counts nor reports compactions. It also never derives
a token total from session stats, so it does not have the problem the other one
solved by accumulating from `message_end`.

## Communication with the main agent

This is the largest genuine difference in capability, and it goes the other way
from everything else: the small extension has the richer channel.

### Channels available

| Channel | pi-core-subagent | pi-subagents |
|---|---|---|
| Parent to child at spawn | prompt, with upstream outputs prepended | prompt |
| Parent to running child | `steer_subagent` | `steer_subagent`, UI composer, `@handle` |
| Child to parent, blocking | `ask_parent`, 10-minute latch | none |
| Child to parent, one-way | `notify_parent` | none |
| Child to sibling | mailbox, `send_agent_message` / `poll_agent_messages` | none |
| Child to parent on completion | task notice plus run notice | `<task-notification>` XML plus a rendered box |
| Parent joins a run | `await_subagent` with intercom delivery | `get_subagent_result({ wait: true })` |

`pi-core-subagent`'s intercom is the thing to steal. A child that gets stuck can
ask a question and block; the parent answers with `reply_subagent` and the child
resumes. Siblings in the same run can message each other. Neither exists in
`pi-subagents`, where a child that needs information has to guess or fail.

And the parked-message mechanism is genuinely clever. While a parent is blocked
in `await_subagent`, child messages are intercepted rather than sent to the
session, and delivered *inside the tool result*:

```
Intercom while waiting:
- [notify] researcher (task_1): found 4 unauthenticated routes

1 child(ren) waiting for your answer:
- auditor (task_2): should I include devDependencies?
  reply_subagent(runId: "...", taskId: "task_2", message: ...)
```

A blocked parent gets the traffic in one place instead of as a pile of follow-up
turns that arrive after it stops waiting. The queue is capped at 24, and past
the cap an `ask` displaces the oldest non-`ask`, so a blocking question is never
dropped for a status update. That prioritisation is the detail that makes the
mechanism trustworthy.

The obvious deadlock risk is handled with instructions rather than machinery.
The child prompt says: poll siblings at most 5 times then proceed on your own
judgment, an unanswered `ask_parent` times out after 10 minutes, and a sibling
marked as gated in the graph may not be running yet so do not wait for it. Every
code path that ends a task also resolves the reply latch with a message telling
the child to stop. That belt-and-braces pairing is what makes a soft instruction
safe.

### Notification quality

`pi-subagents` wins on the delivery mechanics.

Its 200 ms nudge hold is a small idea with a large effect. Every completion
notification sits in a timer keyed by agent id, and `get_subagent_result`
cancels it after marking the result consumed. So a result the parent just read
never arrives again as a follow-up turn. The same suppression is exposed to
other extensions as `subagents:rpc:consume`, for a caller that joined on
`subagents:completed` and reported the result itself.

Its group join batches completions from one turn into a single notification with
a 30-second window and a 15-second re-batch for stragglers, so a fan-out of six
wakes the parent once rather than six times.

Its notification carries two representations in one message: `<task-notification>`
XML the model parses, and structured details a registered renderer turns into
the box the user sees. One event, two audiences, no duplication.

`pi-core-subagent` has one delivery nuance worth copying and it is about
*urgency*, not batching. A task that failed with no output at all is delivered
with `deliverAs: "steer"` instead of `"followUp"`, so it interrupts the parent
rather than waiting for its next turn, and the notice says why: a config-level
error will fail identically on every respawn, so stop and diagnose. A child that
died on spawn is exactly the failure a parent must not discover forty seconds
later.

### Honesty about partial results

Both take this seriously, which is unusual and worth noting.

`pi-subagents` runs it through `status-note.ts`, which appends a state clause to
every non-normal result: stopped by the user, aborted at the turn limit, wrapped
up at the turn limit. Foreground and background get different wording, because a
foreground caller already holds the whole output and has no agent id to fetch
more with, so telling it the output "may be partial" would send it inventing an
id. Every clause is a statement about state and never an instruction to act,
and the file documents two instructions that were tried and removed.

`pi-core-subagent` does the equivalent for the failure taxonomy rather than the
wording. `classifyFailure` and `lastAssistantFailure` distinguish an abort from
a failure from a clean stop, salvage any partial text from the child's messages,
and report both. `pi-subagents`' `finalTurnError` goes further and catches two
shapes a naive implementation reports as success: a `stopReason: "error"` that
pi resolved rather than rejecting, and a `stopReason: "length"` with no text at
all, which is a silent output-token death. Both are bounded by a start index, so
a resume whose new turn failed empty reports empty rather than the previous
turn's answer.

Take all of this. A subagent that reports success with an empty result is worse
than one that fails.

## Token management

### Two totals, two questions

`pi-subagents` draws the line explicitly and correctly:

```ts
getLifetimeTotal(u) = u.input + u.output + u.cacheWrite      // work done
toReportedUsage(u)  = ... includes cacheRead ...             // money spent
```

Each turn's `cacheRead` is the *cumulative* cached prefix re-read on that one
API call. Summing it across turns counts the prefix once per turn, which vastly
overstates how much work happened. But the prefix really is re-read and
re-billed every call, so excluding it understates the bill. So: exclude it from
the display total, include it in the billing figure.

`pi-core-subagent` sums `cacheRead` into its one and only total, which is the
billing answer used as a display number. Its per-task token counters are
therefore inflated relative to work done, and it never exposes a
work-done figure.

If you build a third one, keep both numbers. It costs one extra field.

### Where the accumulator comes from

Both accumulate from `message_end` assistant messages rather than from
`getSessionStats()`. `pi-subagents` states the reason: session stats derive from
`session.state.messages`, which compaction replaces, so a stats-derived sum
resets at every compaction. `pi-core-subagent` gets the same property without
naming it.

`pi-subagents` also avoids pi's own `tokens.total` field for the same
`cacheRead` reason, reading `input + output + cacheWrite` off the stats object
by hand for its session-scoped figure.

### Reporting into the parent session

Only `pi-subagents` can do this, and it is off by default.

Subagents run in their own pi sessions, so nothing they spend appears in the
parent's `getSessionStats()`. A session that delegated everything reads as
nearly free in the footer and `/cost`. pi does aggregate `toolResult.usage`
into session stats, so the way back in is to hang the spend on a tool result.
`PendingUsagePool` accumulates every message from every owned agent, and each of
the extension's tools drains the pool onto its result.

Three details that make it correct rather than approximately correct:

- A background agent that finishes between tool calls has no result of its own
  to ride on, so its spend rides the *next* tool call. The footer catches up one
  call late rather than never.
- Turning the setting off drains the pool immediately, so a later drain cannot
  bill the session in one lump for a window the user opted out of.
- The mention-clone path is skipped by checking for a missing tool-call id: that
  result never becomes a message in the real session, so usage hung on it would
  be spend nobody counts.

And one structural insight worth internalising: nested spend is deliberately
double-booked into every ancestor's record, so a hidden grandchild's tokens show
up on the record a human can see. That makes those records useless as a base for
anything that must count a message exactly once. So the manager exposes a
*separate* per-message callback, fired once per message per agent, and only that
feeds the parent-session pool. If you fold usage upward for display, you need a
second, un-folded channel for accounting.

### Context window reporting

`pi-subagents` reads `getSessionStats().contextUsage?.percent` and surfaces it as
`(62%)` colour-coded in the widget, in the completion XML as
`<context_percent>`, and in `get_subagent_result`. It returns null rather than
zero when there is no declared context window or right after a compaction. The
docs note that `reportUsage` deliberately leaves this untouched, because pi
derives the percentage from assistant messages alone, so a delegating session's
context does not appear to fill up faster than it is.

`pi-core-subagent` reports nothing about context windows.

### Cost

Both read pi's own per-message `usage.cost.total` and neither prices anything
itself, so a model pi has no rates for contributes zero rather than an estimate.

`pi-subagents` then makes a rule out of that: a zero cost prints *nothing*,
because `$0.00` beside real tokens would claim the run was measured and found
free, while a real cost too small to render prints `<$0.0001`. Figures keep
cents at minimum and four decimals at most, because rounding to cents would
print the same number for runs that differed fourfold. It also gates the cost
out of the model-facing XML unless the user turned display on, reasoning that a
figure the orchestrator did not ask for is one it may start reporting
unprompted.

`pi-core-subagent` prints `$0.0412`, or `$<0.0001` for a tiny non-zero cost,
and omits the field when the cost is zero. Same instinct, less ceremony.

## Model selection

This matters most for the extension you are planning, so here is both
implementations in full.

### pi-core-subagent: session-provider-first, then a live probe

```
explicit model?  no  → ctx.model (the parent's)
                 yes ↓
bare id (no "/")     → try the SESSION's provider first: exact id, then endsWith("/id")
exact provider/id    → getAvailable() lookup
progressive split    → registry.find(before, after) for every "/" position
otherwise            → throw "Model not found: <ref>"
                     ↓
ensureUsableModel    → if it differs from the session model, send a real 16-token
                       "ping" completion. On error, fall back to the session model
                       and record a note on the task.
```

Two things stand out.

The **session-provider-first** rule for bare ids is a small, high-value touch. A
user who types `claude-haiku-4-5` almost always means "the one on the provider I
am already authenticated to", and resolving that first avoids landing on a
different provider that happens to expose a similar id.

The **preflight probe** is the more unusual choice. It costs one 16-token
request per non-inherited model per task, and it turns a class of failure that
would surface after a repo copy and a full prompt into a half-second fallback
with a readable note:

```
anthropic/claude-opus-4-6 failed preflight (401 invalid api key);
using session model anthropic/claude-haiku-4-5
```

Whether that is worth it depends on your users. For an extension where the user
picks the model by hand, I think it is: the failure it catches is exactly the one
a hand-picked model produces (a provider you configured once and whose key has
since expired), and a note naming the swap is far better than either a silent
fallback or a dead run.

### pi-subagents: fuzzy scoring with provider fallback

```
1. exact "provider/id", but only if present in getAvailable()   (has auth)
2. fuzzy over available models, with "." normalized to "-":
     exact id or provider/id        → 100
     id or full contains query      → 60 + (qlen/idlen) * 30
     name contains query            → 40 + (qlen/namelen) * 20
     all query tokens found somewhere, 8-digit dates optional → 20
     accepted at >= 20
3. "provider/id" that matched nothing under that provider
   → retry the bare id against every provider
4. otherwise return an error STRING listing every available model
```

Precedence is exact, then fuzzy under the named provider, then the same model
under any provider, then unavailable. So `haiku` and `sonnet` work,
`claude-haiku-4.5` matches `claude-haiku-4-5`, a dated
`claude-haiku-4-5-20251001` matches an undated registry id and vice versa, and a
provider that does not carry the named model does not silently drop you back to
the parent's model.

Returning the error as a *string containing the available model list* is the
right shape for a tool result: the orchestrator that guessed wrong immediately
sees what it could have picked.

### Who wins between caller and config

Both make the agent definition authoritative over the tool call.
`pi-subagents` makes this explicit and reusable:

```ts
modelInput:      agentConfig?.model ?? params.model,
modelFromParams: agentConfig?.model == null && params.model != null,
```

That second flag is the interesting one. It is what lets the same policy engine
treat a caller's out-of-scope model as a hard error while treating a
frontmatter-pinned out-of-scope model as a warning that proceeds. The user
authored the file; the model just made a runtime choice. Different trust, same
check.

A caller-supplied model that resolves to nothing returns the error. A
frontmatter model that resolves to nothing falls back to the parent model
silently, and the `/agents` type list flags it as
`(unavailable, fallback: inherit)`.

### Recommendation for a new extension

Combine them:

1. Resolve exact `provider/id` against `getAvailable()` first, so auth is part
   of resolution rather than a later surprise.
2. Resolve a bare id against the session's own provider before anything else.
3. Fall back to fuzzy scoring, normalising `.` to `-` and treating a trailing
   8-digit date stamp as optional.
4. Retry a failed `provider/id` as a bare id across all providers.
5. On total failure, return an error string listing every available model.
6. Decide whether a preflight probe is worth one tiny request. If the user picks
   the model by hand, it probably is.

That is roughly 100 lines and needs only `ctx.modelRegistry.getAvailable()`,
`.getAll()` and `.find(provider, id)`.

## Thinking effort

The two take opposite positions, and the choice is a real fork in the road.

### pi-core-subagent refuses

```ts
export function validateThinking(model, level) {
  if (!level || level === "off") return;
  const map = model.thinkingLevelMap;
  if (map && level in map && map[level] === null) throw new Error(
    `Thinking level "${level}" is not supported by ${model.provider}/${model.id}. Supported: ...`);
  if (!model.reasoning) throw new Error(
    `Model ${model.provider}/${model.id} does not support thinking. Use thinking: "off".`);
}
```

Called three times per task: once for every task in `createRun`, before the run
exists, so an unsupported level fails the whole call with zero children spawned;
once in `runChild`; and once more after a preflight model swap, because the
fallback model may not support what the original did. The error names the task,
the agent, and whether an agent file's `model:` outranked the requested one.

The schema declares the levels as a closed `StringEnum`, so the model sees the
valid set rather than guessing.

### pi-subagents accepts and discloses

Nothing is validated. pi clamps the level to what the model supports. What the
extension does instead is read the effective level back off the live session and
keep the request beside it when they differ:

```ts
const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
Object.assign(record.invocation, describeModel(session.model));
if (session.thinkingLevel) {
  record.invocation.thinking = session.thinkingLevel;
  if (requested && requested !== session.thinkingLevel) {
    record.invocation.requestedThinking = requested;
  }
}
```

`requestedThinking` is set only where the caller did not get what they asked for,
whether pi clamped it or a frontmatter pin outranked the parameter, and it is
never overwritten once set. The viewer then shows:

```
↳ anthropic/claude-haiku-4-5 · thinking: low (asked max) · background
```

### Which to pick

For an extension whose selling point is that the user sets the effort, I would
do both, in this order:

1. **Validate at the call boundary**, as `pi-core-subagent` does, and refuse
   before spawning. A user who explicitly asked for `max` on a model that cannot
   reason wants to know, not to silently get `off`. Validate every task up
   front, not per child, so a bad graph costs nothing.
2. **Read the effective level back** from the session anyway, as `pi-subagents`
   does, and keep the request when they differ. Validation covers what you can
   predict from `thinkingLevelMap`; reading back covers everything you cannot,
   including a future pi that clamps for a reason your check does not know
   about.
3. **Re-validate after any model fallback.** This is the case both a naive
   validator and a naive read-back miss: the level was fine for the model the
   user picked and is not fine for the one you swapped in.

The mechanics themselves are trivial. `createAgentSession({ thinkingLevel })`,
and `model.thinkingLevelMap` plus `model.reasoning` are the two fields to read.
Note that pi's `ThinkingLevel` type does not include `"off"`, so a
display-oriented type needs widening. `pi-subagents` names that explicitly with
an `EffectiveThinkingLevel = ThinkingLevel | "off"`, marked display-only so the
widening cannot leak into a spawn.

## Concurrency

| | pi-core-subagent | pi-subagents |
|---|---|---|
| Pools | one, per run | two, session-wide |
| Default | 3, max 8 | background 10, foreground unlimited |
| Hard task cap | 16 per run | none |
| Queueing | none, waves run to completion | shared queue, per-pool drain |
| Exemptions | not applicable | nested children, workflow agents |

`pi-core-subagent` bounds concurrency *within a run* and has no session-wide
notion at all, which follows from its model: a run is the unit, and the parent
does not usually have several runs in flight.

`pi-subagents` needs a session-wide pool because every `Agent` call is
independent, and its two-pool split is well argued: a foreground agent blocks
the parent anyway, so charging it to the background pool would let a saturated
pool starve the main session of work it could have done itself.

Four implementation details from `pi-subagents` that generalise to any pool:

- **Claim the slot before the first await.** Creating a worktree is an awaited
  git call, and the drain loop reads counters synchronously. Incrementing after
  the await lets the drain start every queued agent at once while the first is
  still copying its repo.
- **Carry the pool decision from acquire to release.** Never recompute it, or a
  mid-run settings change makes the release disagree with the acquire, which
  either underflows a counter (limit silently lifted) or leaks a slot forever
  (every later spawn queues indefinitely).
- **One queue, per-pool drain by `findIndex`.** With two limits and one FIFO
  `shift`, a saturated pool at the head stalls everything behind it.
- **Every path out of the queue must release its waiter.** A queued record has
  no promise to await and pi has no tool-execution timeout, so a missed release
  is an unbounded hang, not a failed call. And the release gate must resolve
  rather than reject, or the rejection escapes into the caller's tool `execute`
  and takes down pi's whole `Promise.all` tool batch.

That last one is the kind of thing you only learn by shipping it.

## Isolation

Both use git worktrees for write-capable children. The mechanics differ in ways
that matter.

| | pi-core-subagent | pi-subagents |
|---|---|---|
| Trigger | automatic for a write-capable toolset | explicit `isolation: "worktree"` |
| Location | `<git-common-dir>/subagents/<run>/<task>` | `<tmpdir>/pi-agent-<id>-<suffix>` |
| Branch | `subagents/<run>/<task>` | `pi-agent-<id>` |
| Base | the upstream write task's branch, else HEAD | HEAD |
| On failure to create | run in place, with a reason on the task | fail the tool call |
| `node_modules` | symlinked from the main checkout | not mentioned |
| Crash recovery | three-stage sweep with owner files | `git worktree prune` on dispose |
| Partial work | committed on failure or cancel | committed, but the branch is not named in the result |

**Stacking is the idea to steal.** In `pi-core-subagent`, a write task that
`needs` a completed write task branches from *that task's branch*, so the
downstream child actually sees the files its upstream wrote. Without it, a
downstream child that cannot see an upstream's rename writes code against the
old name, and the merge succeeds with exit 0 while leaving a tree that does not
compile. That is the worst possible failure: silent, clean, and broken. Any
implementation with ordered write tasks needs this or needs to refuse ordered
write tasks.

**Location matters more than it looks.** Putting the worktree inside the repo's
git directory means the copy travels with the repo and `git worktree list` finds
it. Putting it in `tmpdir` means it can be wiped by the OS and the repo has a
registration pointing nowhere. `pi-core-subagent`'s owner-file scheme (pid, host
and boot id beside each worktree) is what lets it distinguish "another live pi
owns this" from "a crashed pi left this", including across reboots, and it is
about 40 lines.

**Both preserve partial work, but only one tells you.** `pi-core-subagent`
commits whatever a failed or cancelled child wrote and patches the branch name
onto the task, so the failure notice names it. `pi-subagents`' `cleanupWorktree`
also commits and branches on the error path, since both settle paths call the
same function, but the branch note is appended to `record.result` only on the
success path. So the branch exists and nothing in the parent's result mentions
it. That is worth checking if you copy this shape: preserving the work and
reporting where it went are two separate jobs.

Both are honest that this is a directive, not a sandbox. `pi-subagents` says it
outright: an agent with shell access can `cd` out, so do not rely on isolation
to protect the main checkout. `pi-core-subagent` adds the specific instruction
its own design needs, telling the child never to run branch-switching git
commands and never to touch the shared `node_modules`.

## Extensibility and integration

`pi-core-subagent` emits nine `subagent:*` events and nothing else. There is no
documented way for another extension to spawn into its manager.

`pi-subagents` has a full integration surface: eleven `subagents:*` events, four
RPC channels over `pi.events` with a versioned envelope, and a
`Symbol.for("pi-subagents:manager")` global registry. Two design points are
worth borrowing regardless of scale:

**Gate discovery on a bound lifecycle event.** RPC handlers are wired from
`session_start`, not at factory time, because pi runs every extension factory
before applying an agent's `extensions:` filter and only fires lifecycle events
for survivors. A child session that filtered the extension out never reaches
`session_start` and so never advertises RPC it cannot service. Callers are told
to treat a missing `subagents:ready` as "not available here" and to give
discovery a timeout rather than waiting forever.

**Strip internal capabilities from caller options.** `spawnTopLevel` deletes
nine fields from anything a caller sends, and the comments name the specific
risk each carries: `rootSessionId` names a transcript directory, so a forged
value is a path-traversal primitive; `resumeSessionFile` names a file to open
and replay as a conversation; `reclaim` bypasses handle allocation and would
make name resolution ambiguous. If any option of yours is an internal
capability, allowlist rather than passthrough.

## Pros and cons

### pi-core-subagent

**Strengths**

- Zero dependencies, 3,300 lines, readable in an afternoon.
- Near-zero parent context cost. No catalog, no per-request injection.
- The graph is the best part. Edges gate *and* deliver, so "the coordinator
  forgot to pass the upstream result" stops being a failure mode.
- Validation happens before the first spawn. A cycle, an unknown id, a
  self-edge, an unsupported thinking level, or an unresolvable model all fail
  the call with zero children running.
- The richest child-to-parent channel of the two: blocking questions, one-way
  notices, and sibling mailboxes, all on by default.
- Parked intercom delivery gives a blocked parent everything in one result,
  with asks prioritised over notices.
- Stacked worktree branches remove a whole class of silent merge corruption.
- Serious crash recovery for worktrees, including across reboots.
- A preflight probe catches an unusable model in half a second.
- Startup failures interrupt the parent instead of waiting for its next turn.

**Weaknesses**

- One token total, and it includes `cacheRead`, so displayed counts overstate
  work done.
- No reporting into the parent session's own `/cost`, footer or statusline. A
  delegating session reads as nearly free.
- No context-window or compaction reporting at all.
- No turn limits. A looping child is bounded only by a 6-hour wall clock,
  and a child with a broken tool loop can burn a lot in six hours.
- 16 tasks per run and 8 concurrent is a low ceiling for large fan-outs.
- Agent-file matching by description overlap is clever but opaque. A 2-token,
  40%-coverage threshold over crude stemming will surprise users, and there is
  no way to say "use this exact file".
- No nesting, no scheduling, no scripted orchestration, no structured output.
  Each is deliberate, but they are still absences.
- Almost no configuration. One boolean in one file.
- No integration surface for other extensions beyond reading events.

### pi-subagents

**Strengths**

- Claude Code parity means an existing mental model transfers, and its
  `Workflow` scripts run unchanged.
- The best token accounting of the two: separate work-done and billed totals,
  compaction-proof accumulation, opt-in reporting into the parent session, and a
  disciplined cost display.
- Turn limits are a graceful shutdown rather than a kill, and the resulting
  statuses are distinct and carried into the parent's result text.
- Failure detection catches two shapes that naive code reports as success.
- Notification mechanics are excellent: hold-and-cancel, group batching, and one
  message carrying both a model-facing and a user-facing representation.
- Extremely configurable, with a documented split between live settings and ones
  needing a restart.
- Genuine extensibility: events, RPC, a global registry, and a manager that
  stands down when another workflow tool is present.
- The workflow sandbox is thoughtful. Worker for killability, `vm` for
  determinism, and a prelude that kills the clock because a journal is replayed
  by prefix on resume.
- Nested delegation is depth-capped, ownership-scoped, and honest that the
  allowlist is a privilege boundary rather than a routing hint.
- `@handle` addressing survives record eviction through tombstones, so an
  agent's conversation stays reachable long after its record is gone.

**Weaknesses**

- 21,000 lines and 58 files. The surface area is the cost, and much of it is
  UI, settings, and compatibility.
- Four runtime dependencies, and one of them is arguably the wrong TypeBox.
  pi ships the renamed `typebox` v1; `@sinclair/typebox` is a different package
  pi never loads.
- No child-to-parent channel at all. A stuck child cannot ask a question, and
  siblings cannot coordinate. For its parallel-fan-out use case this is the
  largest functional gap.
- The `Agent` tool description costs about 1,400 tokens in the default mode.
- Thinking levels are not validated, only disclosed after the fact.
- No dependency ordering primitive. Ordering means either a foreground chain
  (blocking the parent) or a workflow script (a whole sandbox to express two
  edges).
- Worktree failure on the error path drops the directory without preserving
  partial work.
- The tool-scoping machinery is correct and genuinely hard to follow. Three
  enforcement points exist because of pi's registration timing, and any change
  there is risky.
- `exclude_extensions` is not a sandbox, and the docs say so: an excluded
  extension's factory still runs, so anything it subscribes directly to the
  shared event bus stays live.

## If you are building a third one

Your stated goals are: no dependencies if possible, the user picks the model,
and the user sets the thinking effort. Working from what each of these got
right:

### Dependency budget

Zero is achievable. `pi-core-subagent` proves it at 3,300 lines. The four
dependencies in `pi-subagents` map to:

| Need | Dependency-free answer |
|---|---|
| Tool schemas | `typebox` as a peer, which is what pi loads. Not `@sinclair/typebox` |
| Frontmatter parsing | `parseFrontmatter`, exported by `@earendil-works/pi-coding-agent` |
| Ids | `node:crypto` `randomUUID().slice(0, 17)`, which is what `pi-subagents` already does for agent ids |
| Cron | Skip it, or accept only intervals and one-shots, which is under 30 lines |

Everything else either comes from pi's own exports (`createAgentSession`,
`SessionManager`, `DefaultResourceLoader`, `getAgentDir`, `createCodingTools`,
`createReadOnlyTools`) or from `node:` builtins. Import Node builtins with the
`node:` prefix so the code runs on both the Bun binary and the Node CLI.

### The spine

```
tool execute
  ├─ validate everything: agent type, model, thinking level, graph if you have one
  ├─ build the record, claim a concurrency slot before the first await
  ├─ resolve config: frontmatter first, tool params fill the gaps
  ├─ build the child prompt: parent prefix first if inheriting, per-call parts after
  ├─ createAgentSession({ model, thinkingLevel, tools, customTools })
  ├─ subscribe: message_end for usage, turn_end for limits, compaction_end for counts
  ├─ prompt, raced against a wall-clock bound
  └─ settle: classify the outcome honestly, release the slot, notify
```

### Non-obvious things to get right the first time

Each of these is a bug one of the two already paid for:

- **Accumulate usage from `message_end`, not from session stats.** Session
  stats reset at compaction.
- **Keep two token totals.** Exclude `cacheRead` from the display total, include
  it in the billing one.
- **Re-anchor a streaming transcript after compaction.** Otherwise the write
  cursor sits past the end of the rebuilt array and streaming halts silently.
- **Bound the returned text.** A byte-measured cap with a pointer to the session
  file, as `pi-core-subagent` does at 24 KiB, is the cheapest protection your
  parent context can get.
- **Place an inherited parent prompt first and verbatim.** That shared byte
  prefix is a free KV cache hit on every spawn.
- **Emit `session_shutdown` before disposing a child session.** pi emits it in
  its own dispose path, so an extension that binds extensions onto a session
  itself must emit it too, or everything a child extension armed in
  `session_start` leaks once per spawn and its next timer tick kills pi.
- **Resolve the reply latch on every exit path** if you build a blocking
  child-to-parent channel. Task cancelled, run cancelled, session ended, parent
  unreachable. All of them.
- **Never reject a queue release gate.** The rejection escapes into the caller's
  tool `execute` and takes down pi's whole tool batch.
- **Distinguish a run that never started from one that failed.** Report it as a
  failed *tool call* (throw out of `execute`), not as a subagent that ran and
  returned an error message, or the model treats it as a finding and moves on.
- **Bound the failure-text search to this invocation's messages.** A resume
  whose new turn failed empty must not surface the previous turn's answer.

### What I would leave out

Judging by how much of `pi-subagents` is defensive machinery for features that
each brought their own failure modes: skip nesting, skip scheduling, skip the
script sandbox, skip `@handle` addressing, and skip cross-extension RPC until
someone asks. None of them is bad, and every one of them costs more code than it
looks like.

What I would not skip, because it is cheap and the absence hurts: the two token
totals, an honest status taxonomy, a bounded return, per-task model and thinking
validation before spawning, and a child-to-parent channel. That last one is the
capability `pi-core-subagent` has and `pi-subagents` does not, it is under 150
lines including the mailbox, and a child that can ask one question is worth more
than a child with three extra configuration flags.
