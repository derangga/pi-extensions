# Spike: Subagent process inspection (Claude Code / OpenCode parity)

> Status: settled by a design review. Three changes open, two were already fixed.
> Date: 2026-09-07
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

| # | Change | Where | Cost |
| --- | --- | --- | --- |
| C1 | The expanded call row prints each task's full prompt, capped at 20 lines | `render.ts:callLines` | a parameter, a conditional, a non-flattening path |
| C2 | The composed prompt is kept and shown in the expanded result row | `run.ts`, `render.ts:resultLines` | one field on `TaskState` and `TaskView` |
| C3 | A child blocked on `ask_parent` shows as `⏸ … asks … 8m41s` | `intercom.ts`, `run.ts`, `render.ts:widgetLine` | one field, one widened hook |

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
