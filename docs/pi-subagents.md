# How `@tintinweb/pi-subagents` works

Source read: `pi-subagents/` at version 0.19.0. About 21,000 lines across 58
files in `src/`, plus roughly 38,000 lines of tests. Four runtime dependencies:
`@sinclair/typebox`, `croner`, `nanoid`, `typebox`.

The goal here is different from a minimal delegation primitive. This extension
reproduces Claude Code's subagent surface inside pi: same tool names, same
calling conventions, same UI patterns, plus a scripted orchestrator whose
scripts are source-compatible with Claude Code's `Workflow` tool.

## The four tools

| Tool | What it does |
|---|---|
| `Agent` | Spawn one subagent. Background by default. Also registers a scheduled job when `schedule` is passed |
| `get_subagent_result` | Status and full result for a background agent, optionally blocking |
| `steer_subagent` | Inject a message into a running agent's conversation |
| `SubagentWorkflow` | Run a deterministic JavaScript script that orchestrates many agents |

A subagent that sets `allowed_subagents` gets its own ownership-scoped copies of
the first three, injected directly as custom tools rather than by loading this
extension in the child.

## The call graph, spawn path

```
Agent tool execute
  ├─ reloadCustomAgents()                       every call, so a new .md is live
  ├─ resolveSpawnType(subagent_type)            case-insensitive, fallback policy
  ├─ resolveAgentInvocationConfig(cfg, params)  frontmatter outranks params
  ├─ resolveModel(modelInput, ctx.modelRegistry)
  ├─ checkModelScope(...)                       enabledModels allowlist
  ├─ branch: schedule?  → scheduler.addJob, return job id
  ├─ branch: resume?    → manager.resume | startBackgroundResume
  ├─ branch: background → manager.spawn(...)    returns id synchronously
  └─ branch: foreground → manager.spawnAndWait(...)

manager.spawn(pi, ctx, type, prompt, options)
  ├─ assertValidSpawnCwd
  ├─ build AgentRecord (handle, alias, lifetimeUsage, depth, ...)
  ├─ poolFor(record)                            background | foreground | none
  ├─ if pool full and not bypassQueue → queue and return
  └─ launch → startAgent
       ├─ claim the pool slot BEFORE the first await
       ├─ createWorktree (isolation: "worktree")
       ├─ runAgent(ctx, type, prompt, runOptions)
       └─ .then(settle) / .catch(settle)
            ├─ status precedence: stopped > aborted > failure > steered > completed
            ├─ cleanupWorktree, append branch note to result
            ├─ abortOwnedChildren(id)
            └─ settleRun → release slot, onComplete, drainQueue

runAgent(ctx, type, prompt, options)              agent-runner.ts, ~830 lines
  ├─ detectEnv, ctx.getSystemPrompt()
  ├─ preloadSkills (when `skills:` is a list)
  ├─ memory block (read-write or read-only, by effective tool set)
  ├─ buildAgentPrompt(config, cwd, env, parentSystemPrompt, extras)
  ├─ extension include/exclude filter → DefaultResourceLoader
  ├─ tool scoping: sessionTools | sessionExcludeTools
  ├─ nested tools + StructuredOutput tool as customTools
  ├─ SessionManager.open | .create | .inMemory
  ├─ createAgentSession({ model, thinkingLevel, tools, excludeTools, customTools })
  ├─ session.bindExtensions()
  ├─ installExtensionToolScope(session, ...)     turn_end renarrow + beforeToolCall block
  ├─ subscribe: turn counting, soft limit steer, usage, compaction, activity
  ├─ session.prompt(effectivePrompt)             prefixed by parent context if inheriting
  └─ optional structured-output retry prompt
```

## Agent types and the registry

Three embedded defaults, in `default-agents.ts`:

| Type | Tools | Model | Prompt mode |
|---|---|---|---|
| `general-purpose` | all 7 built-ins | inherit | `append` |
| `Explore` | read, bash, grep, find, ls | `anthropic/claude-haiku-4-5` | `replace` |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` |

`BUILTIN_TOOL_NAMES` is derived from pi's own factories rather than hardcoded:

```ts
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map(t => t.name)),
];
```

That is read, bash, edit, write, grep, find, ls. Deriving it means the set
tracks pi if a built-in is added or renamed.

User agents load from three directories, lowest priority first:

1. `$PI_CODING_AGENT_DIR/agents/*.md` (default `~/.pi/agent/agents/`)
2. `<cwd>/.agents/agents/*.md`
3. `<cwd>/.pi/agents/*.md`

The type is the frontmatter `name:`, falling back to the filename. A `name:`
containing `:` is refused, because Claude Code reserves that for plugin-scoped
identifiers. Frontmatter parsing uses `parseFrontmatter` exported by
`@earendil-works/pi-coding-agent`, so there is no YAML dependency. A UTF-8 BOM
is stripped before parsing.

An unreadable file is skipped with a warning naming the file and, when it was
overriding a same-named agent, the file that loads instead. With
`strictAgentFiles: true` the initial load throws instead, but mid-session
reloads keep warning so a bad edit does not kill a session on an unrelated
spawn.

`resolveSpawnType` is the dispatch policy. A type that does not resolve to
exactly one *enabled* agent (unknown, disabled, or ambiguous between two agents
differing only by case) goes to `fallbackSubagent`, default `general-purpose`.
Setting it to `none` makes dispatch fail closed with a list of available types.
Nested dispatch never consults this policy: it uses `resolveEnabledTypeIn` and
rejects, so a project fallback cannot hand a nested caller an agent outside its
allowlist.

## Context management

Three separate layers, each independently controllable.

### The system prompt

`buildAgentPrompt` in `prompts.ts` has two modes.

`replace` (the default):

```
<active_agent name="auditor"/>

You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

# Environment
Working directory: ...
Git repository: yes / Branch: ...
Platform: ...

[worktree block]  [workflow-child block]

<the agent file body>

[memory block]  [preloaded skill blocks]
```

`append` (what `general-purpose` uses):

```
<the parent's entire system prompt, verbatim>

<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
...
</sub_agent_context>

<active_agent name="general-purpose"/>

# Environment ...

<agent_instructions>...</agent_instructions>
```

The ordering in `append` mode is load bearing and the code says why: the parent
prompt goes first, verbatim and unwrapped, so it forms an identical byte prefix
with the parent session and the provider's KV cache can reuse those tokens
across every spawn. The per-call parts (`<active_agent>`, the env block) come
after the cached prefix.

`replace` mode also suppresses pi's own re-appending of `AGENTS.md`,
`CLAUDE.md` and `APPEND_SYSTEM.md` via `noContextFiles: true` and an empty
`appendSystemPromptOverride`, because upstream re-appends both *after*
`systemPromptOverride`, which would defeat `prompt_mode: replace`.

The `<active_agent name="..."/>` tag exists so downstream extensions such as
permission systems can resolve per-agent policy by parsing the system prompt.

### Conversation inheritance

`inherit_context: true` runs `buildParentContext(ctx)` and prepends the result
to the *user prompt*, not the system prompt:

```
# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
...
[User]: ...
[Assistant]: ...
[Summary]: <compaction summary>
---
# Your Task (below)
<the actual prompt>
```

Tool results are skipped as too verbose. Compaction summaries are included
because they are already condensed. This is a text rendering of the parent
conversation, so it costs input tokens on the child's first turn and it is
never refreshed afterwards.

This is distinct from what the `@handle` mention path does. A mention-started
agent gets a real in-memory clone of the parent session, entries and system
prompt, taken from memory and compaction-aware. That clone is a throwaway
session holding only the `Agent` tool, and what it spawns is an ordinary
top-level agent.

### The child's own context window

Each child is a full pi `AgentSession`, so it compacts on its own. The
extension tracks that rather than intervening:

- `compaction_end` with `!aborted && result` increments
  `record.compactionCount` and fires `subagents:compacted` with the reason
  (`manual`, `threshold`, `overflow`) and `tokensBefore`.
- `getSessionContextPercent` reads `getSessionStats().contextUsage?.percent`,
  which the widget renders as `(62%)` colour-coded, and the completion
  notification carries as `<context_percent>`.
- `⇊2` in the widget is the compaction count.
- The transcript writer re-anchors after compaction, because compaction
  replaces `session.messages` with a shorter array and would otherwise leave
  the write cursor past the end permanently. It flushes on
  `compaction_start`, then re-anchors in a `queueMicrotask` after
  `compaction_end`, because on the overflow-retry path pi trims the trailing
  error message *after* emitting that event.

### What reaches the parent

For a foreground agent, the whole result inline. For a background agent, the
completion notification carries a 500-character preview and the full text is
only available through `get_subagent_result`. Group notifications use a
300-character preview per agent.

Parent-side context cost for the tool spec is the one real lever:
`toolDescriptionMode` is `full` (roughly 1,400 tokens with the default agents),
`compact` (about 75% smaller), or `custom` reading
`.pi/agent-tool-description.md` with `{{typeList}}`, `{{compactTypeList}}`,
`{{agentDir}}`, `{{isolationGuideline}}` and `{{scheduleGuideline}}`
placeholders.

## Communication with the main agent

### The notification path

Completion goes through the `AgentManager` `onComplete` callback in
`index.ts`. It:

1. Returns immediately for a non-top-level record, so nested children and a
   workflow's agents report only through their owner.
2. Emits `subagents:completed` or `subagents:failed`.
3. Appends a `subagents:record` session entry for history reconstruction.
4. Returns early when `record.resultConsumed` is set.
5. Routes through `groupJoin.onAgentComplete(record)`, which returns
   `pass`, `held` or `delivered`.

The message itself is a `pi.sendMessage` with `customType:
"subagent-notification"`, `deliverAs: "followUp"` and `triggerTurn: true`. The
content is `<task-notification>` XML for the model:

```xml
<task-notification>
<task-id>...</task-id>
<tool-use-id>...</tool-use-id>
<output-file>/tmp/pi-subagents-501/.../agent-abc.output</output-file>
<status>Done</status>
<summary>Agent "Find auth files" completed</summary>
<result>...500 chars...</result>
<usage><total_tokens>12400</total_tokens><tool_uses>3</tool_uses>
<context_percent>8</context_percent><duration_ms>4100</duration_ms></usage>
</task-notification>
```

and a registered message renderer turns the attached `NotificationDetails` into
the themed box the user sees. So the model and the user read the same event in
two different formats from one message.

### The nudge hold window

Every notification is held for `NUDGE_HOLD_MS = 200` in a `pendingNudges` map
keyed by agent id (or `group:<ids>`). `get_subagent_result` calls
`cancelNudge(agent_id)` after marking the result consumed. This is what stops a
result the parent just read from arriving again as a follow-up turn moments
later. A blocking `wait: true` on a queued agent polls at
`NUDGE_HOLD_MS / 4` so it observes completion inside the hold window.

The same suppression is exposed on the bus as `subagents:rpc:consume`, for an
extension that joined on `subagents:completed` and reported the result itself.

### Join modes

`group-join.ts` batches completions. `defaultJoinMode` is one of:

| Mode | Behaviour |
|---|---|
| `smart` | Two or more background agents spawned in the same turn are grouped; a solo agent notifies individually |
| `async` | Every agent notifies on its own |
| `group` | Always group, even for one agent |

Batching is assembled in `index.ts` with a 100 ms debounce on
`currentBatchAgents`, so parallel tool calls dispatched across several event
loop ticks land in one batch. Once a group exists, the first completion starts a
30-second timer (`DEFAULT_TIMEOUT`). On expiry, whatever finished is delivered
as a partial notification and the remainder is re-batched with a 15-second
`STRAGGLER_TIMEOUT`.

### Steering

`steer_subagent` calls `session.steer(message)`, which interrupts the agent
after its current tool execution and appears in the child's conversation as a
user message. If the session does not exist yet the message queues on
`record.pendingSteers` and the manager flushes it from `onSessionCreated`.
Either way `subagents:steered` fires, so a queued steer is observable.

The same mechanism is reachable from the UI: the conversation viewer's `Enter`
opens a composer, and `@handle message` at the prompt sends into a running
agent's conversation with no main-model turn spent at all.

### Turn limits are a conversation, not a kill

In the `turn_end` subscriber:

```ts
if (!softLimitReached && turnCount >= maxTurns) {
  softLimitReached = true;
  session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
} else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
  aborted = true;
  session.abort();
}
```

`graceTurns` defaults to 5. The resulting statuses are distinct and the
distinction is carried all the way to the parent's result text by
`status-note.ts`:

| Status | Meaning | Note appended to the result |
|---|---|---|
| `completed` | finished naturally | none |
| `steered` | wrapped up within grace | wrapped up at the turn limit, output may be partial |
| `aborted` | grace exceeded | aborted at the turn limit, the task is unfinished |
| `stopped` | a human aborted it | STOPPED BY THE USER, the task is unfinished |
| `error` | provider failure or a failed final turn | error headline plus salvaged partial output |

`status-note.ts` carries a long comment explaining what was deliberately left
out of that wording: no instruction to respawn with a higher limit, no
suggestion to ask the user, and never a mention of `get_subagent_result`,
because a foreground caller has no agent id to call it with. Every clause is a
statement about state rather than an instruction to act.

### Honest failure detection

`finalTurnError(session, startIndex)` walks back to this invocation's final
assistant message and reports a failure when:

- `stopReason === "error"`, a provider failure pi resolved instead of
  rejecting, or
- `stopReason === "length"` with no text at all, a silent output-token death.

A `length` stop that did produce text is treated as a legitimate truncated
answer. The `startIndex` bound means a resume whose new turn failed empty
reports empty rather than inheriting the previous turn's answer.

## Token and cost accounting

This is the most carefully reasoned part of the codebase, and it draws a line
most implementations do not.

```ts
export type LifetimeUsage = {
  input: number; output: number; cacheWrite: number;
  cacheRead?: number; cost?: number;
};

export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;   // cacheRead excluded
}
```

Two different questions get two different answers:

- **How much work happened.** `getLifetimeTotal` excludes `cacheRead`, because
  each turn's `cacheRead` is the cumulative cached prefix re-read on that one
  call, so summing it across turns counts the prefix N times. This is what the
  widget, FleetView, the viewer, tool results and the `tokens` field of
  lifecycle events show.
- **What was billed.** `toReportedUsage` includes `cacheRead`, because the
  prefix genuinely is re-read and re-charged every call, and pi counts it the
  same way for the session's own messages. This is what `usage` on the
  lifecycle events carries, and what gets reported into session stats.

The accumulator is fed from `message_end`, not from `getSessionStats()`, and the
comment says why: session stats derive from `session.state.messages`, which
compaction replaces, so a stats-derived sum resets at every compaction.

### Reporting spend into the parent session

Off by default (`reportUsage`). On, `PendingUsagePool` accumulates every
assistant message's usage from every agent this manager owns, and
`withUsageReporting` wraps each of the extension's tools to attach the drained
pool to the tool result:

```ts
execute: async (toolCallId, ...rest) => {
  const result = await tool.execute(toolCallId, ...rest);
  if (!reportUsage || !toolCallId) return result;
  const usage = pendingUsage.drain();
  return usage ? { ...result, usage } : result;
}
```

pi folds `ToolResultEvent.usage` into `getSessionStats()`, which is what the
footer, the statusline and `/cost` read, and attributes it to the
Tools/summaries bucket. Draining means each message is reported exactly once.

Three consequences the code documents:

- A background agent that finishes between tool calls has no result to ride on,
  so its spend is carried by the *next* tool call. The footer catches up one
  call late.
- The `!toolCallId` skip is the mention-clone path. That result never becomes a
  message in the real session, so usage hung on it would be spend nobody counts.
  Skipping leaves it pending for the next real result.
- Turning the setting off drains the pool immediately, so a later drain cannot
  bill the session in one lump for a window the user opted out of.

### Nested spend

Nested children are hidden from every reporting surface, so their usage would
be unattributable. `nested-tools.ts` folds it into **every** ancestor:

```ts
onAssistantUsage: (usage) => {
  for (let id = context.parentAgentId; id !== undefined; ) {
    const ancestor = context.manager.getRecord(id);
    if (!ancestor) break;
    addUsage(ancestor.lifetimeUsage, usage);
    id = ancestor.parentAgentId;
  }
}
```

Because of that deliberate double-booking, `AgentRecord.lifetimeUsage` is
useless as a base for anything that must not count a message twice. The manager
therefore exposes a separate `onUsage` callback fired once per message per
agent, and that is the only thing the parent-session pool reads.

### Cost display

`showCost`, off by default, prints `~$0.0042` beside token counts. The rules are
strict: a model pi has no pricing for reports zero and prints *nothing*, because
`$0.00` beside real tokens would claim the run was measured and found free. A
real cost too small to render prints `<$0.0001`. Figures keep cents at minimum
and four decimals at most, because rounding everything to cents would print the
same number for runs that differed fourfold. A group notification is topped with
the batch total derived from the per-agent rows, so the total can never
disagree with them.

The `<estimated_cost_usd>` field only appears in the model-facing XML when
`showCost` is on, on the reasoning that a figure the orchestrator did not ask
for is a figure it may start reporting unprompted.

## Model selection

`resolveModel(input, registry)` in `model-resolver.ts` returns a `Model` or an
error *string* listing every available model:

1. Exact `provider/modelId`, but only if present in `getAvailable()`, meaning
   it has auth configured.
2. Fuzzy scoring over available models, with `.` normalized to `-` so
   `claude-haiku-4.5` and `claude-haiku-4-5` are the same query:
   - exact id or `provider/id` match: 100
   - id or full contains the query: `60 + (query.length / id.length) * 30`
   - name contains the query: `40 + (query.length / name.length) * 20`
   - every query token found somewhere, with 8-digit date tokens treated as
     optional: 20
   - accepted at score 20 or above
3. A `provider/modelId` query that matched nothing under the named provider
   retries the bare id against every provider, so the same model from another
   provider beats falling back to inherit.
4. Otherwise the error string.

Precedence is exact, then fuzzy under the named provider, then the same model
under any provider, then unavailable. A dated snapshot is not conflated with an
undated id because an exact match always wins.

Who wins between caller and config is decided in
`resolveAgentInvocationConfig`:

```ts
modelInput:      agentConfig?.model ?? params.model,
modelFromParams: agentConfig?.model == null && params.model != null,
```

Frontmatter is authoritative. A caller-supplied model that resolves to nothing
returns the error to the orchestrator; a frontmatter model that resolves to
nothing falls back to the parent model silently, and `/agents → Agent types`
flags it as `(unavailable, fallback: inherit)`.

`describeModel(model)` produces both display forms at once, a short
`modelName` for tight rows and a canonical `provider/id`, and both the
pre-spawn labelling and the post-session relabelling call it, so the label
cannot visibly change when the session starts.

### Model scope

`scopeModels`, off by default, validates the effective model against pi's own
`enabledModels` list read from global `<agentDir>/settings.json` and project
`<cwd>/.pi/settings.json`, project overriding global. The policy in
`model-scope.ts` is source-dependent:

| Source | Out of scope |
|---|---|
| `Agent({ model })` from the orchestrator | hard error listing allowed models |
| cross-extension RPC spawn | error envelope to the calling extension |
| agent frontmatter | warning toast, the pinned model runs |
| inherited from the parent | warning toast, the parent's model runs |

Only exact `provider/modelId` entries are honoured. Globs, bare ids and
`:thinking` suffixes are dropped, and an empty allowed set makes the check a
no-op. The same function is called from the top-level tool, the nested tools and
the workflow host, so no spawn path can escape it. In a workflow, a repeated
warning is toasted once per run.

## Thinking level

The advertised levels are `off | minimal | low | medium | high | xhigh | max`,
declared once as `THINKING_LEVELS` and reused by the tool description, the
generated-agent template and the `/agents` wizard.

Precedence is the same as model: `agentConfig?.thinking ?? params.thinking`.
The level reaches the child as `createAgentSession({ thinkingLevel })`.

Unlike `pi-core-subagent`, nothing is validated up front. pi clamps a level the
model cannot do. What the extension does instead is **report the difference**.
On `onSessionCreated`, the manager overwrites its pre-spawn snapshot with the
effective values read back from the live session:

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

`requestedThinking` and `requestedModel` are set only where the caller did not
get what they asked for, whether pi clamped it or an agent file's frontmatter
outranked it, and neither is ever overwritten once set. The conversation viewer
then renders:

```
↳ anthropic/claude-haiku-4-5 · thinking: low (asked max) · background
```

`showModel`, off by default, adds the model and level to the widget's running
rows. It is off because the row already carries description, turns, tool uses,
tokens and elapsed time, and every character it gains is one the description
loses on a narrow terminal.

## Tool scoping

This is the subtlest machinery in the extension, and it exists because
extensions can register tools long after load. pi-mcp registers from
`session_start` once its servers connect; context-mode registers from
`before_agent_start`.

The problem: pi's `allowedToolNames` gates tool *registration*, not just the
active set, and is frozen at construction, so a name absent from that snapshot
is dropped forever even once the tool actually registers.

The solution has three parts:

- When extensions load, `allowedToolNames` is left unset so pi's live gate
  admits tools whenever they register. The stable part of the scope (this
  extension's own tool names, built-ins the agent did not ask for, and
  `disallowed_tools`) is expressed as `excludeTools`, which pi re-applies on
  every registry refresh.
- `installExtensionToolScope` re-derives scope from the loader's live extension
  maps on every `turn_end` and calls `setActiveToolsByName`. pi emits
  `turn_end` immediately before it re-snapshots the tool set, and listeners run
  synchronously, so the narrow lands in time for turns 2 onward.
- Turn 1 cannot be narrowed at all, because `before_agent_start` fires inside
  `prompt()` and the context snapshot freezes that turn's tools straight
  afterwards with no hook in between. So `session.agent.beforeToolCall` is
  wrapped to block any out-of-scope call by name.

Under `noExtensions` or `isolated: true` the old static allowlist is kept,
because nothing can appear asynchronously and a hard registry gate is the
correct boundary there.

Injected `customTools` (nested delegation tools, `StructuredOutput`) share names
with the excluded set or are not built-ins at all, so they are re-admitted
explicitly through a `readmitToolNames` set applied at all three gates.
`disallowed_tools` can take back a nested tool but not `StructuredOutput`,
because removing the only tool that can satisfy a schema request would make the
request unsatisfiable rather than merely restricted.

### `tools:` and `extensions:` compose

`extensions:` is the sole loading authority: `true`, `false`, or a list of names
and paths with `"*"` as a wildcard. `exclude_extensions:` is a denylist applied
after the include set, and exclude wins. `tools:` decides what surfaces to the
model: built-in names, `*` / `all`, `none` / `""`, and `ext:<extension>` or
`ext:<extension>/<tool>` selectors. Any `ext:` entry flips extension tools to
an explicit allowlist, so unnamed extensions still load and fire handlers but
expose no tools.

Misconfigurations warn rather than abort, through the `onToolActivity`
callback with synthetic names such as `tools-error:...` and
`extension-error:...`: an unknown plain tool name, an `extensions:` entry that
was not discovered, an `ext:` selector for an extension that did not load, an
`exclude_extensions` name that matched nothing, and a contradictory
`exclude_extensions` alongside `extensions: false`.

An honest caveat the code states: `exclude_extensions` is not a sandbox. An
excluded extension's factory still runs once during loading. Exclusion
suppresses its tools and its bound lifecycle hooks, not other load-time side
effects, so a factory that subscribes directly to the shared `pi.events` bus
stays live.

### How scope is advertised

The Agent tool description appends `(Tools: …)` per agent type, and
`formatToolsSuffix` distinguishes three cases that a naive renderer would
collapse:

| `tools:` | Suffix |
|---|---|
| omitted, `*`, `all` | `*` |
| a list of built-ins | that list |
| `none` with `isolated: true` or `extensions: false` | `none` |
| `none`, or only `ext:` entries, with extensions loading | `no built-ins, extension tools only` |

Zero built-ins is not zero tools, and calling it `none` would route work away
from the only agent able to do it.

## Concurrency: two pools, one queue

```ts
const DEFAULT_MAX_CONCURRENT = 10;             // background
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;   // 0 = unlimited
```

`occupiesPoolSlot` charges the background pool for a top-level background
agent. `occupiesForegroundSlot` charges the foreground pool for a `blocking`
record, meaning one a caller is awaiting inline through `spawnAndWait`. The
distinction between `blocking` and `isBackground === false` matters: a detached
RPC spawn is foreground by the second measure but blocks nobody, so it takes no
slot.

Both are keyed through `isTopLevelAgent`, so nested children and a workflow's
agents are outside both pools. For nested children that is not an optimisation:
a parent blocked awaiting its own child queued behind that parent is a
guaranteed deadlock.

Both pools share one queue array, tagged with the pool each entry waits on, and
`drainQueue` uses `findIndex` on pool room rather than `shift`:

```ts
for (;;) {
  const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
  if (i === -1) return;
  const [next] = this.queue.splice(i, 1);
  ...
  void next.start().then(() => next.release(), () => next.release());
}
```

A saturated foreground pool at the head cannot stall every background agent
behind it, and FIFO within each pool is preserved.

Two details that took real work in the source:

- The slot is claimed **before the first await** in `startAgent`, because
  creating a worktree is an awaited git call and `drainQueue` reads the counters
  synchronously in a loop. Claiming after the await would start every queued
  agent at once while the first was still copying its repo.
- The pool is resolved once at start and *carried* to `settleRun`, never
  recomputed, because the user can change `maxConcurrentForeground` from the
  settings menu mid-run. Recomputing would either underflow a counter or leak a
  slot forever.

The decrement lives in `settleRun` and nowhere else. `abort()` on a running
record only fires its controller and leaves the run to settle normally, so
decrementing there too would double-free and permanently lift the limit.

`record.startGate` covers the window where a queued record has no promise to
await. It always resolves and never rejects, because a rejection would escape
into the caller's tool `execute` and take down pi's whole `Promise.all` tool
batch. Every path that removes a queue entry goes through `dequeue`, which
releases the waiter, because a missed release is an unbounded hang and pi has no
tool-execution timeout to bail the caller out.

## Nested subagents

Off by default. A non-isolated custom agent that sets `allowed_subagents` gets
scoped `Agent`, `get_subagent_result` and `steer_subagent` tools injected as
`customTools`. The values are `all` / `"*"` / `true` for any enabled agent, a
comma-separated list, or omitted / empty / `none` / `false` for nothing.

`maxSubagentDepth` defaults to 2, counted from the main session, so main is 0,
its subagents are 1, their children are 2. An agent already at the cap receives
no nested tools at all, not even the result tool, since it can never own a
child. That is what makes `0` and `1` mean "nesting off" rather than "nesting
always fails".

The allowlist is a privilege boundary, and the README says so plainly: a child
runs with its *own* `tools:`, `extensions:` and `isolated:`, and the parent's
restrictions are not inherited. A read-only parent that lists an agent with
write tools has, in effect, write access. `all` reaches every enabled agent
including `general-purpose`.

Enforcement details:

- Ownership: `ownsRecord(record, parentAgentId)` gates result, resume and
  steer, so a parent controls only its own children.
- Nested agents resolve from a registry built for *that branch's* config root
  (`buildAgentRegistry(loadCustomAgents(context.configCwd))`), never through the
  process-global `registerAgents`.
- Nested spawns default to foreground regardless of `backgroundByDefault`,
  because `abortOwnedChildren` kills a detached child when its parent settles
  and a nested child has no notification path of its own.
- When a parent completes, fails, is stopped, or ends a resumed turn,
  `abortOwnedChildren(id)` stops its children. Grandchildren are covered
  transitively.
- Nested records are hidden from top-level tools, lifecycle events and every UI
  surface, but they do write their own transcript, filed under the *root*
  session's directory alongside their ancestors'.
- The child `ctx` is forwarded to the manager unmodified rather than captured at
  tool-build time, because each session builds its own extension runner from
  that session's cwd, session manager and model registry. Capturing early would
  give a grandchild the wrong worktree base and the wrong inherited model.

A subagent session never activates this extension, which is what keeps a child
from building a second manager. The cost is that a subagent gets none of the
extension's other surfaces: no `/agents`, no RPC handlers, no
`subagents:ready`.

## Sessions, handles and eviction

`persist_session` frontmatter wins, else `rememberAgents` (default true) for
top-level agents and always false for nested ones:

```ts
const persistSession = agentConfig?.persistSession ?? (options.nested ? false : rememberAgents);
const sessionManager = options.resumeSessionFile
  ? SessionManager.open(options.resumeSessionFile, sessionDir)
  : persistSession
    ? SessionManager.create(effectiveCwd, sessionDir, { parentSession: ctx.sessionManager?.getSessionFile?.() })
    : SessionManager.inMemory(effectiveCwd);
```

Every top-level agent gets a typeable handle: the agent type lowercased and
slugged, numbered on collision (`explore`, `explore-2`). An optional `name` on
the spawn becomes an additive alias from the same namespace, so an alias can
never shadow a live handle or the reverse.

Records are evicted 10 minutes after they settle by a 60-second timer. What
survives is a tombstone:

```ts
{ handle, alias, id, type, description, sessionFile, completedAt }
```

Only when the record has both a handle and a session file, since an in-memory
session leaves nothing to reopen. `MAX_TOMBSTONES = 100`, oldest evicted first.
Tombstoned names stay reserved in `takenHandles()`, so a later Explore becomes
`explore-2` rather than shadowing a conversation the user can still reach. All
tombstones are cleared on session start and session switch, because a new
session means new handles.

`resolveMention` prefers a live steerable record, then the most recently started
live record, then an exact agent id, and only then a tombstone. Reopening a
tombstone while its record still existed would fork the session.

Session teardown is careful about a real crash the source documents:
`AgentSession.dispose()` only invalidates the extension runner, because pi emits
`session_shutdown` itself in its own dispose path, and `runAgent` is the one
place that binds extensions onto a session without going through that path.
Without the emit, everything an extension armed in `session_start` leaks once
per spawn and its next tick throws from a bare timer callback, killing pi. So
`shutdownChildSession` emits `session_shutdown` with reason `quit`, raced
against a 3-second timeout, then disposes.

## Transcripts

Each agent streams a JSON-lines transcript to:

```
<os-tmpdir>/pi-subagents-<uid>/<encoded-cwd>/<sessionId>/tasks/<agentId>.output
```

The root is created `0o700` and re-chmodded past umask on Unix, swallowing the
error only on Windows. `encodeCwd` handles POSIX paths, Windows drive prefixes
and UNC paths.

`writeInitialEntry` truncates and writes the user prompt.
`streamToOutputFile` subscribes and flushes new messages on `turn_end`. A
resume must never call `writeInitialEntry`, because that would truncate turns
the completion notification still points at; it calls `ensureOutputFile`
(append nothing) and passes the session's current length as `startIndex`.

Governed by `output_transcript` frontmatter, else the `outputTranscript`
project default. The doc is explicit that this governs *only* the transcript: it
is independent of `persist_session` (the pi session on disk),
`isolation: worktree` (a git branch), and `memory:` (durable files).

## Worktree isolation

```
path:   <os-tmpdir>/pi-agent-<agentId>-<suffix>
branch: pi-agent-<agentId>
```

Strict by design: if the worktree cannot be created (not a git repo, no
commits, `git worktree add` failed), the `Agent` call *fails as a tool call*
rather than running unisolated, and the source notes it must be reported as a
failed tool call rather than as a subagent that ran and reported a problem, so
the model does not retry it as prose.

On completion the directory is removed either way. What differs is the branch:
no changes leaves nothing behind, changes are committed to `pi-agent-<id>` with
`--no-verify` so local pre-commit hooks cannot block a local-only commit, and a
result note names the branch and the merge command. If the branch name is
already taken the commit lands on `pi-agent-<id>-<timestamp>` instead, so a
resumed agent cannot overwrite its own earlier work.

Both settle paths call `cleanupWorktree`, so a failed child's partial work is
committed and branched too. Only the success path appends the branch note to the
result, though, so after a failure the branch exists and nothing in the parent's
result names it.

The agent's prompt is told the working directory is an isolated copy and to work
only there, even if other instructions name the main checkout. That directive
exists because an inherited parent prompt or a task prompt mentioning the
project path otherwise walks the agent straight back out of the copy. It is a
directive and not a sandbox, and the docs say so.

`worktreeIsolation: false` drops the `isolation` parameter from both tool
schemas *and* the prose bullet that describes it, and refuses worktrees on every
other path too. The reasoning is worth quoting in spirit: leaving the bullet in
would teach the model to pass a field that is no longer declared, accepted
silently then dropped, and since a refused worktree carries no note on the
result, the model would have every reason to go on reporting a branch that was
never created.

## Scheduling

`schedule` on the `Agent` tool registers a job instead of spawning. Formats are
6-field cron via `croner`, an interval like `5m`, a relative one-shot like
`+10m`, or an ISO timestamp. Jobs are session-scoped, stored at
`<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID-based file locking, so
they survive `/resume` and reset on `/new`.

Restrictions: no `inherit_context` (there is no parent conversation at fire
time), no `resume` (schedules create fresh agents), and `run_in_background:
false` is refused. Scheduled fires pass `bypassQueue`, so a 5-minute interval
cannot be deferred behind long-running manual agents.

`schedulingEnabled: false` removes the parameter from the schema and the
guideline from the description, at zero context cost.

## Scripted workflows

`SubagentWorkflow` runs a deterministic JavaScript script. This is the largest
subsystem (about 4,500 lines under `src/workflow/`, plus three UI files for the
card, the inspector dialog and the menu) and the one with the most interesting
sandbox story.

### The sandbox

Two stacked boundaries, and the source is careful that they are not the same
boundary:

```
host thread  ←postMessage→  worker thread  ←vm context→  workflow script
```

The worker exists for **killability**: `worker.terminate()` stops a runaway
script mid-loop, which an in-process `vm` timeout cannot once the script is
inside an `await`. The `vm` context exists for **determinism**, not security.
The source states the hole plainly: injected globals are host closures, so
`agent.constructor` is still the host `Function`, and
`codeGeneration: { strings: false }` is the load-bearing defence because it
makes `Function("…")` and `eval("…")` throw.

Determinism is enforced by a prelude that runs inside the realm, on one line so
line numbers in reported stacks still match the author's file:

```js
const Date = (function () {
  const RealDate = globalThis.Date;
  const die = function (what) { throw new Error(what + " is unavailable in workflow scripts (breaks resume). ..."); };
  RealDate.now = function () { return die("Date.now()"); };
  Math.random = function () { return die("Math.random()"); };
  return class WorkflowDate extends RealDate {
    constructor() { if (arguments.length === 0) die("new Date()"); super(...arguments); }
  };
})();
```

The reason is `resumeFromRunId`: a run's journal is replayed by prefix, so a
script that reads the clock produces a different prefix on the second run and
the replay silently diverges.

### The script surface

```js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/.')
phase('Audit')
return await pipeline(files,
  f => agent(`Audit ${f}`, { label: `audit:${f}` }),
  (found, f) => agent(`Refute this: ${found}`, { label: `verify:${f}` }))
```

`meta` must be a pure literal. It is extracted by evaluating only that object
literal, in an empty `node:vm` context with a 100 ms bound, and a saved
workflow is recognised by a regex over the source, so naming a non-workflow file
reports that rather than executing it.

`agent(prompt, opts)` options, validated in the worker so a typo fails at the
call that made it:

| Option | Effect |
|---|---|
| `label` | Row name in the progress tree, and the handle `resume` addresses |
| `phase` | Overrides the ambient `phase()`, needed inside pipeline stages where the ambient one races |
| `agentType` | Which agent definition, default `general-purpose` |
| `model` | `provider/modelId` or fuzzy |
| `effort` | One of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. pi's `ThinkingLevel` minus `off` |
| `isolation` | `"worktree"` only |
| `gate` | Shell command run after the agent; non-zero exit fails the agent and its output becomes the error |
| `resume` | Continue the child that ran under that label instead of re-paying its context |
| `schema` | JSON Schema with an object root; resolves to the validated object |

`effort` is a superset of Claude Code's five levels, with pi's `minimal` added.
`resume` is mutually exclusive with `agentType`, `model`, `isolation`, `effort`,
`schema` and `gate`, because a resumed child keeps what it was started with.

`pipeline()` has no barrier between stages, so one item can be in a later stage
while another is still in the first. `parallel()` idles every fast agent until
the slowest finishes.

### Caps

| Cap | Value |
|---|---|
| Agents per run | 1000 |
| Items per `parallel` / `pipeline` | 4096 |
| Nested `workflow()` calls | 256 |
| Script length | 524,288 bytes |
| Concurrency | `max(1, min(16, cpus - 2))` |
| Gate timeout | 10 minutes |

The `max(1, …)` is not decoration: raw `min(16, cpus - 2)` is 0 on a two-core
machine, and a semaphore with zero permits never hands out a slot, so the run
would hang before its first agent rather than fail.

### Where the gate runs

A gated isolated child cannot have its gate run after `spawnAndWait` resolves,
because the manager commits the worktree to a branch and deletes the copy inside
the child's own settle. By then the only tree left to run `npm test` in is the
main one, which would report on code the child never wrote. So the gate runs
from `onBeforeWorktreeCleanup`, inside that settle, and the verdict travels back
on the spawn result. A non-isolated child's gate runs from the runtime instead.
Exactly one execution either way.

### Structured output

`agent({ schema })` gives the child a `StructuredOutput` tool whose input schema
*is* the caller's schema, with `constrainedSampling: { type: "json_schema",
strict: "prefer" }`. The source names the gap up front: Claude Code *forces* the
call, and this cannot, because `toolChoice` exists in pi-ai's provider layer but
is not plumbed through `AgentSession`. So there are four softer pressures:
constrained sampling, the tool description and guideline, validation answering a
bad payload with `isError` so the model can correct inside the same run, and one
extra prompt from `runAgent` when a run ends with nothing captured. That retry
prompt distinguishes "never called it" from "called it wrongly", because telling
a model it got the shape wrong when it never answered sends it looking for a
mistake it did not make.

The validated payload lands on `record.structuredJson`, kept beside `result`
rather than inside it, because `result` is prose that gets a worktree branch
note appended and JSON that has been appended to no longer parses.

### Standing down for company

`workflowsEnabled` unset means auto: on, unless another extension already
provides a `Workflow` or `SubagentWorkflow` tool, in which case this one warns
and disables itself for the session. The match is on exact tool names, never a
substring, so a `github_workflow_run` from a CI integration does not take the
feature down. The check runs at `session_start` because `getAllTools` throws
during extension loading, so the tool is registered first and withdrawn from
the active set through `setActiveTools`, which rebuilds the system prompt before
any turn runs.

## Cross-extension RPC

Four channels on `pi.events`, with per-`requestId` reply channels and a
standard envelope (`{ success: true, data }` or `{ success: false, error }`):

| Channel | Purpose |
|---|---|
| `subagents:rpc:ping` | Availability plus `PROTOCOL_VERSION` (currently 2) |
| `subagents:rpc:spawn` | Spawn, returning an id; always detached |
| `subagents:rpc:stop` | Abort by id |
| `subagents:rpc:consume` | Mark a settled result as read, suppressing its notification |

Handlers are wired from `session_start`, not at factory time, because pi runs
every extension factory before applying the `extensions:` filter and only fires
lifecycle events for survivors. A child session that filtered this extension out
never reaches `session_start` and so never advertises RPC it cannot service.
`subagents:ready` fires only when the extension is loaded *and bound*, so
callers should treat its absence as "not available here" and give discovery a
timeout.

`spawnTopLevel` strips internal capabilities from caller-supplied options before
forwarding: `parentAgentId`, `workflowId`, `depth`, `maxSubagentDepth`,
`configCwd`, `rootSessionId`, `resumeSessionFile`, `reclaim`, `blocking`. The
comments name the specific risk each one carries. `rootSessionId` names a
transcript directory, so a forged value is a path-traversal primitive.
`resumeSessionFile` names a file to open and replay as a conversation.
`reclaim` bypasses handle allocation and would make `@handle` ambiguous.

There is also a `Symbol.for("pi-subagents:manager")` global registry, claimed
only if free, so a child activation cannot point it at a short-lived child
manager.

## Events

| Event | When |
|---|---|
| `subagents:created` | Agent-tool background spawn or detached resume. Not RPC, scheduler or mention spawns |
| `subagents:started` | Transition to running, including from the queue |
| `subagents:completed` | Finished successfully, background or foreground |
| `subagents:failed` | Errored, stopped or aborted. Identical payload shape |
| `subagents:steered` | Steering accepted, including a queued steer |
| `subagents:compacted` | Session compacted, with reason and `tokensBefore` |
| `subagents:scheduled` | Job added, removed, updated, fired or errored |
| `subagents:scheduler_ready` | Scheduler bound, enabled jobs armed |
| `subagents:ready` | RPC handlers registered and armed |
| `subagents:settings_loaded` / `:settings_changed` | Settings applied or mutated |

The four agent-lifecycle events fire for top-level agents only. Nested children
and a workflow's agents emit nothing.

## Settings

Two files, merged on load, project overriding global on any field present in
both:

- `~/.pi/agent/subagents.json`, machine-wide, never written by the menu
- `<cwd>/.pi/subagents.json`, written by `/agents → Settings`

Twenty-four fields. Grouped by what they govern:

**Concurrency and limits.** `maxConcurrent` (10), `maxConcurrentForeground` (0 =
unlimited), `defaultMaxTurns` (unlimited), `graceTurns` (5),
`maxSubagentDepth` (2).

**Dispatch.** `fallbackSubagent` (`general-purpose`, or `none` for fail-closed),
`disableDefaultAgents` (false), `strictAgentFiles` (false),
`backgroundByDefault` (true).

**Features.** `schedulingEnabled` (true), `workflowsEnabled` (unset = auto),
`worktreeIsolation` (true), `agentMentions` (`model`), `fleetView` (true),
`scopeModels` (false).

**Persistence.** `rememberAgents` (true), `outputTranscript` (true).

**Display and accounting.** `widgetMode` (`background`), `viewerMarkdown`
(`assistant`), `showCost` (false), `showModel` (false), `reportUsage` (false),
`toolDescriptionMode` (`full`), `defaultJoinMode` (`smart`).

Failure behaviour: a missing file is silent, malformed JSON logs a warning to
stderr and falls back to defaults, invalid or out-of-range values are dropped
per field, and a write failure downgrades the confirmation toast to a warning
saying "session only; failed to persist".

Which settings apply live and which need a new pi session is not uniform, and
the boundary is real: anything read at tool registration (the `isolation` and
`schedule` parameters, `toolDescriptionMode`, `disableDefaultAgents`,
`workflowsEnabled`) needs a restart, because the tool schema and description are
built once. Runtime behaviour changes take effect immediately.

## Memory and skills

`memory: project | local | user` gives an agent a persistent directory with a
`MEMORY.md` index:

| Scope | Location |
|---|---|
| `project` | `.pi/agent-memory/<name>/` |
| `local` | `.pi/agent-memory-local/<name>/` |
| `user` | `<agentDir>/agent-memory/<name>/` |

Write capability is derived from the *effective* tool set, accounting for
`disallowed_tools`, so an agent with `tools: write` plus `disallowed_tools:
write` correctly gets read-only memory. Read-only agents get a read-only memory
prompt block, which prevents unintended tool escalation: enabling memory cannot
smuggle write access into a read-only agent.

`skills: name1, name2` preloads those skill bodies into the system prompt and
does not inherit the rest. Discovery checks five roots, and per root resolves
`<root>/foo.md`, then `<root>/foo/SKILL.md`, then a recursive descent for
`*/…/foo/SKILL.md`. Symlinks are rejected at every layer, which is a deliberate
deviation from pi, and skill names containing `..`, separators, spaces, a
leading dot or over 128 characters are rejected.

## UI surfaces

- **Widget** above the editor. `widgetMode` is `all`, `background` (the default,
  since a foreground agent already renders inline as its tool result) or `off`.
  Rows carry spinner, description, turn counter `↻5≤30`, tool uses, tokens with
  context percent and compaction count, elapsed time, and live tool activity.
- **FleetView** below the editor: `main` plus every running agent, earliest
  first, navigable from an empty prompt with arrow keys. A running workflow is
  one row carrying its agent counts, and its own agents are filtered out
  because the run reports for them.
- **Conversation viewer**, a live scrolling overlay of an agent's full
  conversation, with inline steering on `Enter`, stop on `x` twice, and `m`
  cycling Markdown rendering across off / assistant / all.
- **`/agents`** menu: running agents, agent types with source and model
  indicators, a create wizard (manual or AI-generated), scheduled jobs,
  workflow runs, and settings.
- **Workflow inspector**, a framed two-pane dialog over a run: phases on the
  left, the selected phase's agents on the right, and five keys (stop, pause,
  skip, retry, open conversation).

The `viewerMarkdown` default of `assistant` is scoped rather than all-or-nothing
for a stated reason: assistant text *is* Markdown by contract, while a tool
result is arbitrary bytes, and a Markdown pass over one rewrites things that
occur constantly in real output. A `#` in a shell script loses its `#`, a `---`
line is swallowed as a setext heading, indented output is re-fenced, and
`| a | b |` is redrawn as a box-drawing table. Each of those reads as the tool
having misbehaved. Two rewrites are suppressed outright in all modes because
they change data rather than layout: ordered-list markers keep their source
numbering, and backslash escapes are not normalised.

## Runtime dependencies, and what they are for

| Package | Used by | Replaceable? |
|---|---|---|
| `@sinclair/typebox` | `Type` in three files | Yes, with pi's peer `typebox` v1 |
| `typebox` | declared, not imported directly | Should be the peer, not a dependency |
| `croner` | cron parsing in `schedule.ts` | Only if you want cron expressions |
| `nanoid` | job ids in `schedule.ts` | Yes, `node:crypto` `randomUUID` |

Worth flagging for anyone reading this as a template: pi depends on the renamed
`typebox` v1 package, and `@sinclair/typebox` is a different package pi never
loads. It works here because TypeBox schemas are plain JSON Schema objects at
runtime, but per the conventions in this repo an extension should peer
`typebox` rather than bundle the old name. The agent registry itself needs no
YAML parser, because pi exports `parseFrontmatter`.
