# pi-broodmother

A [Pi Coding Agent](https://pi.dev) extension for handing research off to child
agents.

One tool call takes a whole batch of tasks. Each task can name the tasks it
needs, which holds it until those finish and pastes their output into its
prompt. No edges means everything runs in parallel.

Children are read-only until you say otherwise. They read, grep, find and list,
and one row in the settings panel lets them edit, write and run commands as
well. You pick the model and the thinking effort from the same panel instead of
letting the orchestrating model guess.

The name is the Dota 2 hero, who spawns her own children and sends them out to
do the work. That is roughly the job here.

## Install

```sh
pi install npm:pi-broodmother
```

Restart your Pi session.

```sh
pi --version    # needs 0.84 or newer
node --version  # needs 22 or newer
```

One runtime dependency, `effect`. No build step, no API keys of its own. Every
child runs on a model Pi is already authenticated to.

## Quick start

Ask for something that needs several parts of the project read at once:

> Work out how sessions are persisted and how the TUI reads them.

The model calls `subagent` once with two or three tasks. A widget appears above
the editor with one line per child: what it is, what tool it just ran, tokens,
cost and elapsed time. Your turn ends. Each child reports back as it settles,
and `subagent_result` returns everything the run produced.

To make one task wait for another, give the first an `id` and list it in the
second's `needs`:

```json
{
  "tasks": [
    { "id": "sessions", "agent": "a session-format archaeologist",
      "task": "map session persistence",
      "prompt": "Find where sessions are written and read. Report file paths and the on-disk shape." },
    { "id": "tui", "agent": "a TUI reader", "needs": ["sessions"],
      "task": "trace the read path",
      "prompt": "Given the session format above, find every place the TUI reads it." }
  ]
}
```

`tui` starts once `sessions` settles, with the output of `sessions` already in
front of it. You never copy a result from one task into another, so you cannot
forget to.

## What a child sees

This is the part people get wrong, so it is worth spelling out.

A child gets a fresh session. It sees:

- Pi's base system prompt
- the `agent` string, as "You are a dependency archaeologist." If the name
  matches an agent file, that file's body is used instead
- a short instruction block saying what it may do and how to reach you, which
  is where `read-only` or `read-write` is spelled out for the model
- the output of every task it needs, as `## Output of <id>` blocks
- its own `prompt`

It does not see your conversation. Not the question you asked, not the files
you have open, not the earlier turns. It also does not load the project's
context files, prompt templates or any other extension. Skills it does load,
the same ones the parent sees. The rest is left out deliberately: inheriting it
costs input tokens on every child and a research task rarely needs it.

So write each `prompt` as if you were handing it to someone who just walked in.
State the goal, the scope and the shape of the answer you want.

Upstream output arrives ahead of the prompt text. Write `{previous}` anywhere in
the prompt to place the first need's output inline instead.

## What a child can and cannot do

Always: `read`, `grep`, `find`, `ls`. If [`@ff-labs/pi-fff`](https://www.npmjs.com/package/@ff-labs/pi-fff)
is installed, its search tools load too. If it is not, the run says so in a note
and carries on with Pi's own tools. Skills load as well, the same ones the
parent session sees, from `~/.agents/skills` and any `.agents/skills` up to the
git root. A project's skills need the project trusted, the same answer you gave
the parent.

Never: spawn its own children, or reach any other extension. Enforced by the
tool list the session is built with, not by asking nicely.

Only when Permissions is `read-write`: `edit`, `write`, `bash`. Read this part
before you flip it. A writable child reaches as far as the session that spawned
it. Nothing keeps it inside the project directory, because an absolute path or
a `..` resolves like any other path, and nothing asks you before a change
lands, which is also true of the writes you make in Pi yourself. So the switch
grants a child what you already had, in a session you are not watching
keystroke by keystroke.

Two things make that reviewable. `git diff` shows what actually changed, and
every task reports the session file holding its full transcript, so you can
read what a child did and why. A child stopped part way through, by
`subagent_cancel` or by running out of turns, says in its result that its
changes may be half applied; nothing rolls them back.

The default is `read-only`, and a settings file written before this row existed
loads as `read-only` too.

Two tools exist only for talking to you:

- `ask_parent` blocks the child on one question. You answer with
  `reply_subagent`. If nothing arrives in ten minutes the child is told to
  proceed on its best judgment and state the assumption it made.
- `notify_parent` sends a finding or a warning and the child keeps working.

Each child's session is persisted under your session, so `/resume` finds it and
every result carries the transcript path.

## The four tools

| Tool | What it does |
|---|---|
| `subagent` | Start a run. Takes the whole batch of tasks. `autoAwait` blocks until everything settles, otherwise you end your turn and read the results later |
| `subagent_result` | Read a run, or one task of it. `wait` blocks until it settles or until a child asks something. `verbose` adds model, thinking, turns and any notes |
| `reply_subagent` | Answer a child that called `ask_parent` |
| `subagent_cancel` | Stop a run. Children in flight are aborted and report what they had; tasks that never started are marked skipped |

`runId` defaults to the most recent run everywhere it appears.

The package is called pi-broodmother, but the tools are not. They keep the plain
word `subagent` because a tool name is something the orchestrating model reads
and has to understand from the name alone. It knows what a subagent is.

Task ids may hold letters, digits, underscore and hyphen. Leave `id` off and you
get `task_1`, `task_2` and so on. Duplicate ids, an unknown `needs` entry, a
task that needs itself and a cycle are all refused before any child starts, with
a message naming what to fix.

While you are blocked in a waiting call, anything a child says comes back inside
that same tool result. You never have to stop waiting to hear that a child asked
a question.

## Settings

`/broodmother` opens a panel with six rows.

| Row | What it does |
|---|---|
| Model | `inherit` follows the parent session, or pick one model that every child runs on |
| Thinking effort | `inherit` leaves the per-task choice in charge, or pin a level. The list only offers what the resolved model accepts |
| Concurrency | How many children run at once |
| Max turns | Turn budget per child before it is asked to wrap up |
| Max tasks | Most children one call may spawn, 1 to 16. A call over the cap is refused before any child starts |
| Permissions | The most a child may do. `read-only` is files in and nothing out; `read-write` adds `edit`, `write` and `bash`. Last row on purpose: every row commits as it changes, so a gate at the top would be one stray arrow key away from granting a shell |

Concurrency and max tasks answer different questions. Concurrency is how many
children run at the same time, so it moves wall time and memory. Max tasks is
how many run at all, so it is the one that bounds what a batch costs.

Changes apply and save as you make them, so closing the panel saves nothing
further. Settings live in `pi-broodmother.json` under Pi's agent directory, and the
panel prints the path because hand-editing reaches anything the rows do not
offer. `PI_BROODMOTHER_CONFIG` overrides the location.

A settings file that cannot be read or parsed falls back to defaults and says
so, rather than failing the extension load. A single out-of-range field is
dropped on its own, leaving the rest of the file in force.

## Which model a child runs on

Four places can name a model or a thinking level. Highest wins:

1. An agent file, if the task addressed one by name
2. The `/broodmother` setting
3. The task's own `model` and `thinking` fields
4. The parent session

Both user-authored sources beat what the orchestrating model asked for, and the
more specific one wins. The setting ships as `inherit`, so per-task picks keep
working until you name something concrete. That is what keeps "one task in this
batch is trivial, run it on a small model" available without giving up the
guarantee that a pinned setting holds.

Model names are matched loosely. A bare id resolves against your session's
provider first, dots and hyphens are treated the same, and a trailing date stamp
is optional in either direction. Only models you have credentials for are
candidates.

Every task's model and level pair is checked before the run exists, so a bad
pair fails the call naming the task with zero children spawned. A level someone
wrote down and a level that merely rode in from the parent session are treated
differently on purpose: the first fails the run and lists what the model does
accept, the second is quietly lowered to the strongest level that model takes,
with a note. Nobody asked for `max` on a child that happens to be a small model,
so refusing the whole run over it would be rude.

Any model that is not your session's gets one real 16-token request before the
run starts, sent once per distinct model rather than once per task. This catches
the failure a hand-picked model actually produces, which is a provider
configured months ago whose key has since expired. A model that fails falls back
to your session's, with a note naming both.

### Agent files

Give `agent` a bare name and it loads a file instead of being read as a role.
First match wins:

```
<project>/.pi/agents/<name>.md
<project>/.agents/agents/<name>.md
<agent dir>/agents/<name>.md
```

The body becomes the child's system prompt. Frontmatter `model` and `thinking`
pin those for the task, and nothing overrides them: the agent file sits at the
top of the ladder above.

Anything that is not a bare name, such as "a dependency archaeologist", is read
as a role invented for this one call. There is no catalog to maintain and no
per-call context cost for one.

## Limits and outcomes

A child gets 30 turns by default. At the limit it is told to wrap up and given 5
more turns, then aborted. A 30 minute wall clock sits behind that. Output over
24 KB is cut with the transcript path appended.

Every task settles into one of these, because you should act differently on
each:

| Outcome | Meaning |
|---|---|
| `completed` | Finished on its own |
| `wrapped_up` | Hit the turn limit and wrapped up; the answer may be partial |
| `aborted` | Still going after the grace turns |
| `timed_out` | Hit the wall clock |
| `stopped` | You cancelled the run |
| `failed` | The provider errored or the session never started |

A task whose needs produced nothing is marked skipped rather than run against a
prompt with a hole in it, and the skip names which needs failed. One dead child
never takes its siblings down with it.

A child that dies before producing any output interrupts you rather than waiting
its turn, because that failure will repeat if the task is respawned unchanged.

## Accounting

Two token totals, because they answer different questions and neither can be
recovered from the other. `tokens` is input plus output plus cache writes, which
is the work a run did. `billedTokens` adds cache reads, which is the bill it ran
up. Cost is Pi's own per-message figure summed, so a model Pi has no rates for
contributes zero rather than a made-up number.

Your own session totals are untouched. A delegating session reads as cheaper
than it was.

Three events go out on Pi's bus so a status bar or anything else can draw run
state without importing this package: `pi-broodmother:run-started`,
`pi-broodmother:task-settled`, `pi-broodmother:run-settled`. They carry ids and status
only, never prompts or output.

## What this does not do

Each of these was considered against a working implementation and cut.

The worktrees, branches and merge story write agents would want. Nested
spawning. Scheduling. A scripted workflow sandbox. Cross-extension RPC. Handle
based addressing. Parent conversation inheritance. A peek pane, since every
result carries a session path and `tail` covers it.

**The limitation worth knowing about.** Permissions is one switch for the whole
extension, so a batch is all read-only or all read-write. Mixing them, letting
three researchers stay read-only while one implementer writes, needs a per-task
override that does not exist yet. Until it does, a plan-then-implement chain
either runs entirely in write mode or gets split across two calls with a visit
to the panel in between.

Writable children also share one working tree with no isolation between them.
Two children editing the same file in the same wave will interleave, and
nothing detects it. Give a wave one writer, or sequence the writers with
`needs`. Worktrees are the real answer and they are not here.

## Dependencies

One runtime dependency, `effect`. It carries the concurrency, the structured
cancellation and the resource scoping this package is built on: a run is a set
of fibers over a dependency graph, each child session is an acquire and release
pair, and a cancelled run has to tear down every child without leaking a
session. That is the whole of the manager, not a convenience on top of it.

Pi and `typebox` are peers. Tool schemas are typebox because that is what
`registerTool` takes.

`@ff-labs/pi-fff` is optional and never declared. If it is present in the
install it loads into children; if not, the run notes it and uses Pi's own read
tools.

## Requirements

- Node.js 22 or newer
- Pi Agent 0.84 or newer
- At least one model with credentials configured. `inherit` needs your session
  to have a model at all

## License

MIT. See [LICENSE](./LICENSE).
