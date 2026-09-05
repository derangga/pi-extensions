# How `@arhen/pi-core-subagent` works

Source read: `pi-extensions/packages/core/pi-core-subagent` at version 1.3.52.
About 3,300 lines across 12 files in `src/`. Zero runtime dependencies. Peers
on `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and
`typebox` v1.

This extension has one idea and refuses to grow a second: **a delegation is a
dependency graph, and the graph edge both gates a task and delivers its input.**
Everything else in the file list exists to serve that.

## File map

| File | Lines | Job |
|---|---|---|
| `index.ts` | 393 | The 7 parent tools, `/subagents`, the peek shortcut, session hooks |
| `manager.ts` | 1469 | `SubagentManager`: run state, child sessions, notifications, persistence |
| `graph.ts` | 116 | `resolveNeeds`, `applyUpstream`, `runWaveScheduler`, `waveNotation` |
| `worktree.ts` | 366 | Git worktree creation, commit, diff, crash reaping |
| `agentfile.ts` | 152 | Find a user agent file by description overlap |
| `child.ts` | 94 | The 4 tools every child carries |
| `format.ts` | 243 | Widget component, notices, usage strings, truncation |
| `peek.ts` | 273 | Read-only pane that tails a child's session JSONL |
| `schemas.ts` | 84 | Typebox parameter schemas |
| `mailbox.ts` | 35 | Sibling message boxes |
| `types.ts` | 72 | `RunSnapshot`, `TaskSnapshot`, `UsageStats` |

## The call graph

```
subagent tool execute
  └─ manager.startInBackground(params, ctx)
       ├─ createRun(params, ctx)                       validate before anything spawns
       │    ├─ mode check (single | tasks | chain, never two)
       │    ├─ stray top-level field check
       │    ├─ MAX_TASKS = 16
       │    ├─ task id safety + duplicate + generated-collision check
       │    ├─ resolveNeeds(inputs, mode)              unknown id, self-edge, cycle
       │    ├─ per task: resolveAgentFile → resolveChildModel → validateThinking
       │    └─ build RunSnapshot, open one mailbox per task, emit run-created
       └─ executeTasks(run, inputs, ctx)               detached, not awaited
            └─ runWaveScheduler(tasks, concurrency, outputs, settled, run)
                 └─ per ready task, up to `concurrency` at a time:
                      runChild(run, task, { ...input, task: applyUpstream(...) })
                        ├─ resolveAgentFile              body/model/tools
                        ├─ toolset: explicit tools > file tools > read-only|write
                        ├─ resolveChildModel + validateThinking + ensureUsableModel
                        ├─ createWorktree (write-capable only, stacked on upstream)
                        ├─ DefaultResourceLoader({ noExtensions: true, appendSystemPromptOverride })
                        ├─ createAgentSession({ model, thinkingLevel, tools, customTools })
                        ├─ child.subscribe(onChildEvent)  usage, activity, failure
                        ├─ Promise.race([prompt, failure, settled, timeout])
                        └─ finally: commitWorktree, branchDiff, dispose, remove
```

The leader's turn ends at `startInBackground`. Everything after that runs on
its own and reports back through `pi.sendUserMessage`.

## Modes are one scheduler, four shapes

`resolveNeeds` in `graph.ts` normalizes every mode into an edge list:

- `single`: one task, no edges, concurrency forced to 1.
- `tasks`: edges are whatever `needs` says, empty by default.
- `chain`: index `i` gets `needs: [ids[i-1]]`, so a chain is a path graph.

Then `runWaveScheduler` loops: take every task whose needs are all settled, run
that wave with `mapWithConcurrency`, mark them settled, repeat. If a wave comes
back empty and tasks remain, the loop stops and the leftovers are marked
aborted with `Never ran: no runnable wave`.

Cycle detection happens in `resolveNeeds`, at call time, before a single child
starts. A malformed graph costs nothing. This is the design point the README
argues hardest for and the code actually delivers it.

### The edge carries data

`applyUpstream(task, needs, outputs)` builds the dependent's prompt:

```
## Output of api
<api's finalText>

## Output of db
<db's finalText>

---

<the task text, with {previous} replaced by the FIRST need's output>
```

The leader never copies an upstream result into a downstream prompt, so it
cannot forget to. A task with no needs that still writes `{previous}` gets the
placeholder stripped and a note saying it was empty.

A task whose need failed is never run. `runWaveScheduler` checks
`outputs.has(need)` and pushes it onto `skipped`, which `executeTasks` turns
into `status: aborted` with `Skipped: upstream task(s) did not complete`.

## Context management

This is the whole reason the extension exists, and the mechanism is short.

Each task gets its own `AgentSession` in the same OS process. No subprocess, no
IPC. The child's resource loader is built with `noExtensions: true`, so the
child loads no extensions at all, which is also what stops this extension from
re-entering itself in the child.

The child's system prompt is assembled by `DefaultResourceLoader`'s
`appendSystemPromptOverride`:

```
[ ...pi's own base prompt layers,
  (agent file body OR inline `prompt`) + "\n\n" + subagentInstruction ]
```

`subagentInstruction` is built per task and states: you are a subagent, your
bash already runs in the project directory so never prefix `cd`, do not call
delegation tools, return a concise final answer, here is your mailbox roster
(`task_1 (researcher), task_2 (writer)`), poll siblings at most 5 times then
proceed, an unanswered `ask_parent` times out after 10 minutes, and call
`notify_parent` once when done. Write agents get an extra paragraph about the
worktree branch and the shared `node_modules` symlink.

What flows back to the leader is only `task.finalText`, capped at 24 KiB by
`truncateText` (`FINAL_OUTPUT_CAP = 24 * 1024`, byte-measured, with a footer
pointing at the child session file). A child can burn 200k tokens reading files
and the leader sees a page of text.

Nothing is injected into the leader's context per request. There is no agent
catalog and no context hook. The parent-side cost is 7 tool schemas.

Child sessions are always persisted: `SessionManager.create(childCwd,
undefined, { parentSession: getParentSessionFile(ctx) })`, so every child has a
real JSONL transcript on disk and nests under the parent in `/resume`. That
file path is what `subagent_status` returns and what `/subagents peek` tails.

## Communication with the leader

Four channels, all always on.

| Direction | Mechanism | Delivery |
|---|---|---|
| leader → child at spawn | task text with upstream blocks prepended | the prompt |
| child → leader, blocking | `ask_parent` | parks the child up to 10 minutes |
| child → leader, one way | `notify_parent` | `sendUserMessage(..., followUp)` |
| child → sibling | `send_agent_message` / `poll_agent_messages` | in-memory mailbox |
| leader → running child | `steer_subagent` | `child.prompt(msg, { streamingBehavior: "steer" })` |

### `ask_parent` and the reply latch

`onAskParent` flips the task to `awaiting_parent`, notifies the leader, and
awaits `awaitParentReply(runId, taskId, 600_000)`. That returns a promise held
in `pendingReplies` keyed `runId:taskId`. `reply_subagent` resolves it. On
timeout the child receives a plain-language instruction to proceed on its own
best judgment and state the assumption it made.

Every path that ends a task resolves that latch with a message telling the child
to stop: task cancelled, run cancelled, task being finalized, parent
unreachable, session ended. A child can never be left hanging on a dead parent.

### Parked messages while the leader waits

This is the cleverest piece in the file. When the leader calls `await_subagent`
(or passes `autoAwait: true`), `awaitRun` registers an entry in `parked` for
that run. While such an entry exists, `collectParked` intercepts every child
message instead of sending it to the session, and wakes the waiter.

So a leader parked on a run gets the intercom traffic *inside its tool result*
rather than as separate follow-up turns:

```
Run <id>: Subagents parallel finished: 2/3 succeeded, 1 failed.
...
Intercom while waiting:
- [notify] researcher (task_1): found 4 unauthenticated routes
- [done] writer (task_3): completed ...

1 child(ren) waiting for your answer:
- auditor (task_2): should I include devDependencies?
  reply_subagent(runId: "...", taskId: "task_2", message: ...)
```

The queue is capped at `PARKED_MSG_CAP = 24`. Past the cap, an `ask` displaces
the oldest non-ask so a blocking question is never dropped in favour of a
status update. `autoAwait` breaks out of its wait loop as soon as any `ask`
arrives, so the leader can answer it and go back to waiting.

### Notification wording is deliberate

`notifyTask` picks `deliverAs: "steer"` instead of `"followUp"` when
`isStartupFailure(task, kind)` holds, meaning the task failed with no
`finalText` at all. A child that died on spawn interrupts the leader; a child
that failed after doing work waits for the next turn. The notice for a startup
failure says so explicitly: a config-level error will fail identically on every
respawn, so stop and diagnose.

A completed task whose child already called `notify_parent` gets a pointer-only
notice rather than a second copy of the summary. There is a `ponytail:` comment
on that line naming it as a deliberate shortcut.

## Token and cost accounting

`updateUsageFromMessage` runs on every `message_end` for an assistant message:

```ts
task.usage.turns += 1;
task.usage.input      += usage.input      ?? 0;
task.usage.output     += usage.output     ?? 0;
task.usage.cacheRead  += usage.cacheRead  ?? 0;
task.usage.cacheWrite += usage.cacheWrite ?? 0;
task.usage.cost       += usage.cost?.total ?? 0;
```

`aggregateUsage` sums tasks into `run.aggregateUsage`. `formatUsage` renders
`8 turns · ↑ 42.1k · ↓ 3.4k · $0.0412`, with `$<0.0001` for a real but tiny
cost.

Two things to note:

- `cacheRead` is summed into the displayed total. That over-counts the cached
  prefix, because each turn's `cacheRead` is the cumulative prefix re-read on
  that one call. It is the honest number for billing and the misleading one for
  "how much work happened".
- The parent session's own totals are never touched. `/cost` in the leader
  session counts only the leader. A run that delegated everything reads as
  nearly free. There is no equivalent of a usage-reporting switch here.

Cost comes from pi's own per-message `usage.cost.total`, so a model pi has no
rates for contributes zero rather than an estimate.

## Model selection

`resolveChildModel(ctx, explicit)` in `manager.ts`:

1. No explicit model, return `ctx.model` (the leader's).
2. No `modelRegistry`, return `ctx.model`.
3. A bare id (no `/`) is tried first against models from the **session's own
   provider**, by exact id then by `endsWith("/" + ref)`. This is what makes
   `model: "claude-haiku-4-5"` land on the provider you are already using.
4. Exact `provider/id` against `getAvailable()`.
5. Progressive split on every `/` in the string, calling
   `registry.find(before, after)`. This handles provider ids that themselves
   contain a slash.
6. Otherwise `throw new Error("Model not found: " + ref)`.

Then `ensureUsableModel` does something no other implementation I read does:
if the resolved model differs from the session model, it **sends a real
16-token `ping` completion** to the provider. On error it falls back to the
session model and records a note on the task:

```
anthropic/claude-opus-4-6 failed preflight (401 invalid api key);
using session model anthropic/claude-haiku-4-5
```

That note is surfaced in the run summary and the completion notice. The cost is
one tiny request per non-inherited model per task. The benefit is that an
unusable model fails in half a second instead of after a worktree copy and a
prompt.

## Thinking level

`validateThinking(model, level)` refuses rather than clamps:

```ts
const map = model.thinkingLevelMap;
if (map && level in map && map[level] === null) throw new Error(
  `Thinking level "${level}" is not supported by ${provider}/${id}. Supported: ...`);
if (!model.reasoning) throw new Error(
  `Model ${provider}/${id} does not support thinking. Use thinking: "off".`);
```

It is called twice per task and once per task up front. `createRun` validates
every task's `(resolved model, thinking)` pair before the run is created, and
the error names the task, the agent, and whether an agent file's `model:`
outranked the requested one. So an unsupported level fails the whole call with
zero children spawned. `runChild` re-validates after a preflight model swap,
because the fallback model may not support the level the original did.

The level reaches the child as `createAgentSession({ thinkingLevel })`. Levels
are `off | minimal | low | medium | high | xhigh | max`, declared as a
`StringEnum` in the schema so the model sees the closed list.

## Toolsets

```ts
const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS    = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const WRITE_CAPABLE  = ["bash", "edit", "write"];
```

Resolution order in `runChild`:

```ts
const allowedTools  = input.write ? WRITE_TOOLS : READONLY_TOOLS;
const fileTools     = file?.tools?.filter(t => allowedTools.includes(t));
const explicitTools = input.tools ?? (input.write ? WRITE_TOOLS : undefined);
const baseTools     = explicitTools ?? (fileTools?.length ? fileTools : allowedTools);
const tools         = [...baseTools, ...CHILD_TALK_TOOLS];
```

Note the filter on `fileTools`. An agent file can narrow the leader's read/write
choice but never widen it. An explicit per-call `tools` beats the file and
records a `toolsNote` saying so. The 4 talk tools are appended unconditionally.

Worktree eligibility follows the *effective* toolset, not the `write` flag:
`canWrite = baseTools.some(t => WRITE_CAPABLE.includes(t))`. So
`tools: ["bash"]` earns a worktree without `write: true`, and an agent file that
narrows a write agent to read-only gets no branch.

## Agent file matching

`agentfile.ts` matches by `description` overlap, not by name. This is the most
unusual choice in the extension: the model invents an agent name that fits the
goal, and a user file whose description covers that goal takes over.

Search order, all collected then scored:

1. From the task `cwd` up to the filesystem root, at each level:
   `.agents/agents`, `.claude/agents`, `.pi/agents`.
2. Home: the same three subdirectories under `dirname(dirname(agentDir))`.

Scoring, in `tokens` and `score`:

- Lowercase, split on `[a-z0-9]+`, drop a 34-word stopword list and 1-char
  tokens, then crude stemming: strip `ing` when longer than 5, strip `es` after
  a sibilant when longer than 4, else strip a trailing `s` when longer than 3.
- Shared tokens between `name + " " + task` and the file's `description`.
- Reject unless at least 2 tokens are shared **and**
  `shared / min(uniqueDescTokens, uniqueQueryTokens) >= 0.4`.
- Highest shared count wins. Ties keep the first seen.

A file with no `description` can never match. The body is truncated at 64,000
characters with a note telling the author to slim it down. The walk result is
cached per `agentDir + cwd`, cleared wholesale at 512 entries.

## Worktree isolation

Only for write-capable tasks, and only in a git repo.

```
path:   <git-common-dir>/subagents/<runId>/<taskId>
branch: subagents/<runId>/<taskId>
base:   the newest completed upstream write task's branch, else HEAD
```

Stacking is the part worth copying. If task `doc` needs task `api` and both
write, `doc`'s worktree branches from `api`'s branch, so `doc` actually sees the
files `api` wrote. The README makes a specific claim about why: without
stacking, a downstream child that cannot see its upstream's rename writes code
against the old name, and the merge succeeds with exit 0 while leaving a tree
that does not compile. Stacking removes that class by construction.

Mechanics worth noting:

- `node_modules` is symlinked into the copy, so installs escape the worktree.
  The child is told in its prompt never to install, upgrade or delete
  dependencies, and to edit the manifest only.
- If the task `cwd` sits below the repo root, the child runs at the equivalent
  subdirectory inside the copy. If it sits outside the repo, the worktree is
  removed and the task runs in place with `isolationReason: "task cwd is
  outside the repository"`.
- The commit runs `git add -A -- . :(exclude)node_modules :(exclude,glob)**/node_modules/**`
  then commits with `-c commit.gpgsign=false -c user.name="pi subagent" -c
  user.email=subagent@local --no-verify`. It first asserts the worktree's HEAD
  is still the expected branch and throws if the child moved it.
- A failed or cancelled task still gets a partial commit, so the branch keeps
  whatever the child wrote before dying.
- Sibling branches that touched the same file produce a `CONFLICT RISK` line in
  the summary, naming the overlap.

Crash recovery is a three-stage sweep on `session_start`, guarded by an owner
file next to each worktree carrying `{ pid, host, boot, at }`:

| Function | What it does |
|---|---|
| `reapDeadWorktrees` | Registered worktrees under the container that no live run owns: commit the leftovers, keep the branch, drop the directory |
| `cleanupMerged` | Branches already merged into HEAD: delete branch and directory, skipping any branch a live run holds |
| `sweepStale` | Directories git no longer tracks and whose owner is dead: remove |

`ownerAlive` is careful: a different host means "assume alive", a different
boot id on the same host means dead, same pid as us defers to the in-memory
`ownsWorktree` set, and `process.kill(pid, 0)` throwing `EPERM` counts as alive.

## Persistence

Runs are mirrored to a sidecar beside the parent session file:

```
<parent-session>.jsonl  →  <parent-session>.subagents.json
```

`persist` writes the newest 50 runs to `<sidecar>.<pid>.<nonce>.<seq>.tmp` then
renames, chaining writes through `this.persistChain` and dropping any write
whose sequence number has been overtaken. `restoreFromSidecar` cleans leftover
`.tmp` files, loads the array, and rewrites any non-terminal task to `aborted`
with `Interrupted by session reload`.

This is a display and audit record. Nothing resumes from it.

## Limits and caps

| Constant | Value | Where |
|---|---|---|
| `MAX_TASKS` | 16 | `types.ts` |
| `DEFAULT_CONCURRENCY` | 3 | `manager.ts` |
| `MAX_CONCURRENCY` | 8 | `manager.ts` |
| `DEFAULT_RUNTIME_MS` | 1 hour, with `auto-limit on` | `manager.ts` |
| `UNLIMITED_RUNTIME_MS` | 6 hours, the default ceiling | `manager.ts` |
| `PARENT_REPLY_TIMEOUT_MS` | 10 minutes | `manager.ts` |
| `PARKED_MSG_CAP` | 24 | `manager.ts` |
| `FINAL_OUTPUT_CAP` | 24 KiB | `format.ts` |
| mailbox poll body | 4,000 chars | `child.ts` |
| agent file body | 64,000 chars | `agentfile.ts` |
| widget lines | 10 | `format.ts` |

The runtime cap is enforced as one leg of a `Promise.race` against
`child.prompt`, so it is a wall clock bound, not a token bound. There is no
turn limit at all.

`/subagents auto-limit on|off` persists to
`<agentDir>/subagents-config.json`, which is the extension's only settings
file, holding exactly one boolean.

## UI surfaces

- An above-editor widget, throttled to one render per 150 ms, with a 700 ms
  pulse timer that only runs while some task's last activity was a talk tool.
  That is how a talking agent gets the `⇄` blink.
- `/subagents` lists the newest 10 runs as compact lines.
- `/subagents peek` and `ctrl+shift+a` open a read-only pane. `enter` tails the
  selected child's session JSONL from the last 64 KiB, polling every 700 ms.
  `x` then `y` aborts one child, which is the pane's only mutation.
- `subagent_status` returns each child's session file path, so a live child can
  be watched with `tail -f` from any terminal or multiplexer. The extension
  deliberately ships no multiplexer integration.

## Events on the bus

`manager.emit` sends these through `pi.events`, all prefixed `subagent:`:
`run-created`, `run-updated`, `task-updated`, `task-aborted`, `run-completed`,
`notification`, `intercom`, `session-event`, `runs-restored`. There is no RPC
channel and no documented way for another extension to spawn into this manager.

## What it deliberately does not do

Naming these matters, because each is a decision rather than a gap:

- No nesting. Children load no extensions, so they never get delegation tools,
  and the prompt tells them not to look for any.
- No structured output. The README argues the point directly: a structured
  return schema would add a second, less trustworthy witness than an exit code,
  so verification is pushed into the task text as a runnable `Verify:` command
  and into the leader as `git diff --stat`.
- No turn limits, no per-agent context inheritance, no scheduling, no scripted
  orchestration, no cross-extension RPC, no settings beyond one boolean.
- No usage reporting into the parent session's own totals.
