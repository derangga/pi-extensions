# Spike: Subagent process inspection (Claude Code / OpenCode parity)

> Status: five changes settled and shipped. The pane stays deferred, refused
> twice now for different reasons.
> Date: 2026-09-07, extended 2026-09-08 with C4, C5 and the correction to D
> Package: `pi-broodmother` (`packages/pi-broodmother`)
> Pi pin: `0.84.4` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`)

## Summary

The first draft of this spike argued for an overlay inspector pane and spent
four pages comparing four ways to build one. A review of the actual code found
that the pane was answering the wrong question. What a user wants from Claude
Code and OpenCode is two things: see what a child is doing, and see what the
parent told it to do. Neither needs a pane, and the second is currently blocked
by one truncation constant.

Three changes deliver it, each a single field or a conditional. The pane is
deferred until they have been lived with.

A later round added two more and refused the pane a second time. The reason it
came up again was a different one, worth writing down: watching a child in order
to tune the prompt the orchestrator sends it. That turned out to be served by
what the expanded row already prints, once C5 stopped throwing away the answer.
The pattern across all five is the same, and it is the thing to check first next
time someone asks for a surface here: the data was already in memory, and a
constant was hiding it.

| # | Change | Where | Cost |
| --- | --- | --- | --- |
| C1 | The expanded call row prints each task's full prompt, capped at 20 lines | `render.ts:callLines` | a parameter, a conditional, a non-flattening path |
| C2 | The composed prompt is kept and shown in the expanded result row | `run.ts`, `render.ts:resultLines` | one field on `TaskState` and `TaskView` |
| C3 | A child blocked on `ask_parent` shows as `⏸ … asks … 8m41s` | `intercom.ts`, `run.ts`, `render.ts:widgetLine` | one field, one widened hook |
| C4 | A child that has gone silent shows as `quiet 3m12s` | `lifecycle.ts`, `run.ts`, `render.ts:widgetLine` | one hook, one field, one constant |
| C5 | The expanded result row prints the child's answer as lines, not a flattened slice | `render.ts:resultLines` | one call swapped for `promptBlock` |

C4 and C5 were settled by a later round, after the first three had shipped. They
are recorded here rather than in a second document because they came out of the
same conversation and answer the same question: what a person watching a run can
actually see. C5 in particular is C1's defect one line down.

Two further changes this review proposed were already in the tree when it ran: a
running child already reports its `sessionFile`, and the widget already repaints
once a second while a run is unsettled. The review called both live defects
because the reads behind that claim came back incomplete. `run.ts:viewTask` reads
`state.result?.sessionFile ?? state.progress.sessionFile`, and
`render.ts:createWidgetHost` holds an unref'd `setInterval` started on the first
unsettled run and cleared on settle. Nothing there needs doing.

## What the first draft got wrong

Three claims in the original did not survive a read of the code. They are worth
keeping because each one is a live defect, not a documentation slip.

**A running task reports `turns: 0`.** `run.ts:viewTask` reads `turns` from
`state.result`, which only exists once the child settles, so the original layout
sketch showing `turns 6` on a running writer was reading a number that is always
zero there. The transcript path half of this claim was already fixed:
`sessionFile` falls back to `state.progress.sessionFile`. Live turns stay out of
scope, because the wrap-up logic owns that number and the path is what unlocks
`tail`.

**Reading the intercom queue consumes it.** The original proposed that a detail
pane read parent traffic "the same way `formatTrafficReport` does". That is not
a read. `ParkedWaiter.wait` drains, and `PendingAsk` holds a channel and a
deferred, never the question text. A surface reading the queue would steal
messages from whoever called `subagent_result` with `wait`. Showing a blocked
child needs new state that nothing drains. That is C3.

**Neither prompt reaches the run view.** A task carries two strings: `task`, the
three-to-five word label `graph.ts:13` calls "the short label, for rows and
messages", and `prompt`, the whole instruction. `TaskState` keeps only the label.
The template never arrives, and the composed prompt `graph.ts:287` builds with
`composePrompt(task.prompt, task.needs, outputs)` goes straight into
`runChildLifecycle` and is dropped. So nothing reading a `TaskView` can say what
any child was told. That is C2.

One more finding came out of the same read.

**The prompt is already rendered, then cut at 64 characters.** `callLines`
prints each task's goal through `truncate(goal)`, whose default is `GOAL_MAX =
64`, unconditionally. `ToolRenderContext` hands `renderCall` an `expanded` flag
that `callLines` ignores, and `renderResult` already uses its equivalent. In
Claude Code the subagent prompt is visible for exactly this reason: it is a tool
call argument and expanding the row shows it. For a flat run `prompt` is exactly
what the child receives, because `composePrompt` returns it untouched when there
are no edges, so honouring `expanded` is full parity for the common case. That is
C1.

Two more details only show up on reading the code around it. `text()` does
`value.replaceAll(/\s+/g, " ")` before anything is truncated, so a multi-line
prompt is flattened to one line, and lifting the 64 character cut is not enough
by itself. And `PartialTask`, the shape `callLines` reads its arguments through,
does not declare `prompt` at all, so the expanded row has to be pointed at the
right field or it enlarges a three word label.

## Decided

### C1. The expanded call row prints the full prompt

`callLines` takes the `expanded` flag from `ToolRenderContext` and, when set,
prints each task's prompt in full up to 20 lines, followed by a line naming how
many were dropped and where the transcript is. Collapsed rendering does not
change.

The cap is per task with no total budget. An eight task call therefore expands
to roughly 160 lines, which is fine: expanding is deliberate and the row
scrolls. A budget shared across tasks would give a wide run two lines per prompt,
which is the truncation problem this change exists to remove.

The row keeps its short label in both modes and the prompt block goes beneath it,
so nothing is printed twice and a collapsed row is byte-identical to before.
`promptLines` reads the raw string and splits on newlines; `promptBlock` applies
the cap and the pointer, shared with the result row so the two cannot drift.

`text()` cannot be the path to the expanded prompt. It runs
`value.replaceAll(/\s+/g, " ")`, which is right for a one line goal and wrong
for a block: it would join every line of the prompt into one before the cap
applied. The expanded branch reads the raw string, splits on newlines, and
truncates each line to width.

### C2. The composed prompt is kept

`TaskState` gains `prompt: string | undefined`, assigned in `Manager.runTask`
beside `status = "running"` so a single `changed()` carries both. `TaskView`
exposes it. A task that never dispatched leaves it undefined and the render omits
the block. `task` keeps meaning the short label, unchanged.

It renders through `resultLines`, which is the TUI path, and **not** through
`detailLines`. `detailLines` feeds `formatRun`, whose output becomes the tool
result content the orchestrator reads. Putting a prompt there would bill the
orchestrator for a template it wrote itself plus upstream output it already has.
`resultLines` needs no new plumbing, because `details.run` already carries the
whole `RunView`.

Same 20 line cap and pointer as C1, through the same `promptBlock`. The pointer
counts lines and nothing more: the transcript path already has its own line
below, and naming it twice would be noise.

The child's system prompt is deliberately not exposed. With an agent file it is
that file's body, which is on disk and openable. Without one,
`run.ts:systemPromptFor` returns `You are <agent>.`, derivable from the agent
name the widget already prints.

### C3. A blocked child is visible

`TaskChannelOptions.onWaitingChange` exists today and nothing wires it. Widen it
from a boolean to carry the question and a timestamp:

```ts
onWaitingChange?: (ask: { question: string; since: number } | undefined) => void
```

`Manager` stores it on `TaskState`, `TaskView` exposes it read-only, and nothing
drains, so `subagent_result` with `wait` keeps working unchanged.

In the widget the ask replaces the activity segment, because a blocked child has
no current tool call. The question text itself stays in the expanded result row,
so one line stays one line and the nine line widget budget is untouched.

```
running:  • writer · → Read src/run.ts · 3 tools · 1.1k
blocked:  ⏸ writer · asks · 8m41s · 3 tools · 1.1k
```

`⏸` is U+23F8, which matches the plain geometric family `statusIcon` already
uses and needs no patched font. `statusIcon` and `statusColor` both branch on a
waiting task before reading its status, so a blocked child reads as `warning`
rather than as an ordinary running row. The ask elapsed and the task elapsed
share one `formatDuration`, because two formatters would eventually disagree
about what `8m41s` looks like.

Honest scope note: this is a status indicator, not a bug fix. An ask already
reaches the parent, either as a `followUp` user message through
`pi.sendUserMessage`, or as the return value of a parked
`subagent_result`. What the transcript cannot give is which child is blocked
right now and for how long against the ten minute reply timeout. That is the
whole value of the field.

No fourth event channel. `waiting` rides every `onChange` snapshot, so anything
in-process can already see it, and no out-of-process consumer has asked.

### C4. A child that goes silent says so

`widgetLine` grows one segment, `quiet 3m12s`, sitting beside the activity and
ahead of the stats so the narrow-terminal truncation eats the numbers first.

It is not a stuck detector, and the wording carries that. Every threshold that
judges "stuck" has to separate a wedged child from a four minute build, and
nothing on the line can tell those apart. So the code judges nothing: it prints
how long the child has been silent and the reader decides. `quiet` rather than
`idle` because a child mid-build is not idle, and rather than `stuck` because
that is a claim the data does not support.

What resets the clock is every sign of life: `tool_execution_start`,
`tool_execution_update`, `message_update` and `message_end`. The two `_update`
cases are why this is a separate `onActivity` hook rather than a field on
`TaskProgress`. `report()` calls `onProgress`, whose observer in `run.ts` calls
`changed()`, which rebuilds every `RunView` of every run. That is affordable
once per tool call and ruinous once per token. `onActivity` writes
`TaskState.lastActivityAt` and notifies nobody, which works because
`SubagentWidget.render` calls its `runs()` thunk fresh on every repaint and
`createWidgetHost` already ticks once a second while a run is unsettled.

Only `bash` and `powershell` ever emit `tool_execution_update`; every other
built-in tool declares the callback and never calls it. That is the right
coverage anyway, since nothing else runs long enough to reach the floor.

The floor is 30 seconds and hardcoded. It is a render threshold, not a verdict:
with everything above resetting the clock, an ordinary child sits near zero, and
printing that on every row would be noise. A command that writes nothing until it
exits will cross the floor while being perfectly healthy, and showing `quiet 3m`
there is correct rather than a false positive, because that is exactly what is
happening.

Skipped for a blocked child, which already carries the ask elapsed measured
against the parent reply timeout: two durations a few segments apart, differing
by a second, only invite the reader to work out why. Skipped for a pending task,
because waiting on an upstream edge is the graph working. Gone once the child
settles. No icon or colour change, because `warning` is scarce on nine lines and
C3 spends it on a child that needs an answer from the user specifically.

An absent `lastActivityAt` falls back to `startedAt`. A child that has said
nothing at all since dispatch is the case most worth surfacing, not the one to
stay silent about.

### C5. The answer is readable next to the prompt

`resultLines` printed the child's output through `text()` and then
`truncate(body, 120)`. `text()` flattens every newline, so a structured answer
arrived as one squashed line, 120 characters of the 24KB `RESULT_CAP_BYTES` had
already kept. It now goes through `promptBlock`, the function three lines above
it, labelled `output:` for the reason the prompt block is labelled.

This is C1 repeating one line down: data already retained, already behind an
expand keypress, hidden by a constant. Reading a prompt against the answer it
produced is the whole reason to expand this row, and it is the loop that makes
the orchestrator's own instructions improvable.

`detailLines` is untouched, so the orchestrator pays nothing, for C2's reason.

## Explicitly not doing

**No activity history.** `TaskProgress.activity` stays one string, the last tool
call. A ring of recent calls is about four lines to collect, but with the pane
deferred there is nowhere to render ten of them: the widget is capped at nine
lines total, one per task. Collecting it now would mean guessing the cap and the
phrasing before anything displays it. The full history is in the transcript file,
which `sessionFile` already reaches mid-run.

**No pane.** See below.

**No change to the README.** Deferring the pane means the line under "What this
does not do" stays true. Nothing here is a peek pane. Five fields and renderers
are not a surface.

## Deferred: the overlay pane

The original spike's recommendation, kept for whoever picks it up. It was not
rejected, it was sequenced behind the five changes so that it would render fields
that exist rather than invent them.

### What exists today

`pi-broodmother` shows a read-only widget above the editor and keeps detail
inside tool results. Every row is a `TaskView`; none is focusable.

| Concern | File |
| --- | --- |
| Extension entry | `src/index.ts` |
| Run model | `src/run.ts` |
| Child session | `src/child.ts` |
| Child lifecycle | `src/lifecycle.ts` |
| Intercom | `src/intercom.ts` |
| Graph | `src/graph.ts` |
| Render | `src/render.ts` |
| Tools | `src/tools.ts` |
| Settings | `src/settings.ts`, `panel.ts`, `command.ts` |

### The four options

**A. Make the widget focusable.** `setWidget` is `aboveEditor` and capped at
`WIDGET_MAX_LINES = 9`. A selectable widget fights the editor for keys and has
no room for detail. Rejected.

**B. Overlay via `ctx.ui.custom`.** Two panes, `SelectList` over tasks on the
left, detail on the right, live from `Manager.onChange`. Fits the existing
`command.ts:openPanel` shape. This was the recommendation.

**C. `ctx.ui.select` picker.** Modal and not live, so it cannot show anything
ticking. Useful as the fallback when `hasUI` is false.

**D. Tail `sessionFile` directly.** Couples to Pi's on-disk session format and
races compaction. Belongs as a key inside B, not as the whole view.

**Correction to D, found later.** D was answering a question nobody had to ask.
Children are not subprocesses: `child.ts` builds them with `createAgentSession`
in the parent extension's own process, so the parent holds the child's
`AgentSession` object. `lifecycle.ts` already calls `session.subscribe` on it,
and that listener receives every tool call, every tool result and every
assistant text delta as it happens. It handles five event types and discards the
rest. So a live view of a child was never a plumbing problem and never needed the
on-disk format: it is a discarding problem, entirely inside this package. What a
pane would actually need is a bounded buffer where `TaskProgress.activity` keeps
one 60 character phrase, and a decision about how that reaches a surface without
pushing a snapshot rebuild per token, which is the same trap C4 documents.

Two more facts for whoever builds it. `pi.registerShortcut` takes a raw `KeyId`,
not a rebindable namespaced id, so a user cannot rebind it; and a key bound to a
reserved action is dropped with a warning rather than an error, which takes
`ctrl+x`, `ctrl+g`, `ctrl+k` and `shift+tab` off the table silently. `KeyId` has
no chord support, so a leader sequence has no shipped path. None of that matters
much, because a picker does not need one: one key opens a component, and the
component owns the arrows while it has focus. Every `ctx.ui.custom` call site in
Pi's own examples is reached from a command handler, none from a shortcut.

### One correction to the option analysis

The A-versus-B trade-off was framed as a false pair. `OverlayHandle` carries
`unfocus()` and `setHidden()`, so an overlay can stay visible while releasing
focus back to the editor. A persistent unfocused panel that takes focus on a
keybinding is a third shape, and neither A nor B describes it. Whoever builds the
pane should start there.

### What the pane would need that the five changes do not provide

- A focus router that checks `keybindings.matches` before consuming keys.
- A choice of which run to show when `Manager.order` holds more than one.
- The activity ring, once there is somewhere to draw it.
- A headless path for `hasUI === false`, which C is good enough for.

## Verification

The three corrections above were found by reading `packages/pi-broodmother/src`
against `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
and `node_modules/@earendil-works/pi-tui/dist/*.d.ts`. Each is anchored to a
line, so renaming a field breaks the claim, which is the point.

Planned checks for the five changes:

| Change | Check |
| --- | --- |
| C1 | `render.test.ts` golden strings: collapsed row unchanged, expanded row prints a multi-line prompt as multiple lines, the `+N lines` pointer |
| C2 | `run.test.ts` asserts `prompt` holds the substituted string for a task with `needs`, and stays undefined for a skipped one |
| C3 | `intercom.test.ts` asserts the hook fires with the question and clears on release; `render.test.ts` golden string for the blocked line |
| C4 | `lifecycle.test.ts` counts pings across all four events and asserts a tool update pings without adding a progress report; `render.test.ts` golden strings for below the floor, above it, the `startedAt` fallback, and the blocked and pending cases |
| C5 | `render.test.ts` asserts a multi-line answer stays on multiple lines, the cap and pointer apply, and a task with no output prints no block |

Each of those was checked by breaking the source and watching it fail, not by
watching it pass: dropping the `tool_execution_update` ping, raising the floor
out of reach, and reverting C5 to the old flattening cut each took two tests down
and nothing else.

Unit tests prove the shape of the data. They cannot prove it ever arrives, so one
scenario goes in `test/manual/broodmother.feature`: a real child blocks on
`ask_parent`, the widget shows the marker, and the elapsed count moves.

`npm run check` is the gate.

## References

- `packages/pi-broodmother/src/run.ts` — `TaskView`, `RunView`, `Manager`, `viewTask`
- `packages/pi-broodmother/src/render.ts` — `callLines`, `widgetLine`, `resultLines`, `createWidgetHost`, `GOAL_MAX`, `WIDGET_MAX_LINES`, `WIDGET_THROTTLE_MS`
- `packages/pi-broodmother/src/lifecycle.ts` — `TaskProgress`, `runAcquiredChild`, `RESULT_CAP_BYTES`
- `packages/pi-broodmother/src/intercom.ts` — `TaskChannelOptions`, `PendingAsk`, `ParkedWaiter`, `PARENT_REPLY_TIMEOUT_MS`
- `packages/pi-broodmother/src/graph.ts` — `composePrompt`, `PREVIOUS`
- `packages/pi-broodmother/src/tools.ts` — `detailLines`, `formatRun`, `resultLines` wiring
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ToolRenderContext`, `ExtensionContext.ui`
- `node_modules/@earendil-works/pi-tui/dist/tui.d.ts` — `Component`, `OverlayHandle`
