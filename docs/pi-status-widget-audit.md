# pi-status-widget audit

Read against the Pi extension guidelines at
<https://pi.dev/docs/latest/extensions>, 2026-09-11, package version 0.1.1.
Baseline `npm run check` is green: 1668 tests pass, 28 skipped.

Nothing here is a crash or a data-loss bug. The package is careful code with
real test coverage and comments that argue for their decisions instead of
restating them. Five things are worth changing, ordered by who notices them.

**All five are fixed**, on branch `fix/pi-status-widget-audit`, one commit
each. The findings below are left as written so the reasoning survives; two
turned out wider than the audit claimed, and one more problem fell out of
fixing them:

- Finding 1 was not only the git widgets. `thinking-level` had the same bug on
  a model that does not reason, so the fix went in at the widget level instead
  of per preset and reaches hand-edited configs too.
- Writing a test for finding 4 revealed that the panel suite's skip guard
  probed an absolute nix store path that Pi had since moved. All 29 of those
  tests had been skipping silently, on every machine. The guard now calls
  `initTheme` and catches, and the suite passes.
- Finding 5 turned on a detail the audit did not know: pi-tui replaces the
  whole argument text with the chosen item's value, not the word under the
  cursor.

## 1. Git widgets leave orphan icons outside a repository

All three shipped presets draw bare git icons when the working directory is not
a git repository. Rendered at width 120 with `EMPTY_GIT_INFO`:

```
default    🤖 anthropic/opus • 🧠 high • 📏 100 • 🌿  • 📈 (+0,-0) • 💸 $0.0000 • ⏳ 0m
compact    🤖 opus 🧠 high 🌿  🧩 10% 💸 $0.0000
git-heavy  🤖 anthropic/opus • 📂 tmp • 🌿  • 🔖  • 🔀  • 📈 (+0,-0) • ↕️
```

`git-heavy` spends five of its seven segments saying nothing, each with its own
dot separator.

The mechanism to prevent this already exists and works. Every git widget
declares `hideWhenEmpty` in `baseOptions` and overrides `text` to `""`, which
only makes sense if the intent was for them to disappear. `test/widgets.test.ts`
proves both halves: line 208 asserts the orphan `"🌿 "` at the default, line 210
asserts `undefined` with `hideWhenEmpty: true`. The presets in `src/presets.ts`
never set the flag.

`git-diff` needs a second change. It renders `(+0,-0)`, which is never empty, so
`hideWhenEmpty` cannot reach it. The other four git widgets guard on
`ctx.git.isRepo` or a null field and return `""`; `src/widgets/git/diff.ts:15`
is the one that does not.

Fix: set `hideWhenEmpty: true` on the git widgets in all three presets, and give
`git-diff` the `isRepo` guard its siblings have.

## 2. Session metrics are collected every frame whether or not a widget reads them

`src/data.ts:46` calls `collectSessionMetrics(ctx.sessionManager.getBranch())`
on every footer draw. `getBranch()` walks the session tree to the root and
allocates a fresh array of the whole branch; `collectSessionMetrics` then walks
that array. Two passes over every entry in the session, plus an n-element
allocation, per draw, including during token streaming.

Measured cost of the second pass alone, 200 iterations averaged:

| entries | per call |
| ------- | -------- |
| 500     | 0.019 ms |
| 2000    | 0.033 ms |
| 10000   | 0.154 ms |

The `getBranch()` walk and allocation sit on top of that and are not measured
here. The numbers are small. The argument is not that the footer is slow, it is
that the work is often entirely wasted: `git-heavy` ships with no cost and no
total-time widget, so every one of those passes computes a number nothing draws.

Git already has the gate. `gitCommandsFor(config.lines)` runs once per config
change and returns `undefined` when no git widget is enabled, and `data.ts`
skips collection on that. Metrics has no equivalent.

Fix: add `needsMetrics(lines)` next to `gitCommandsFor`, derived from the
registry so it reads each spec's declared `dependencies` rather than hardcoding
a widget list. Pass the boolean into `collectStatusbarData` and return an
`EMPTY_METRICS` constant when it is false. Both gates then derive from the same
`config.lines` in `replaceConfig`, so they cannot disagree.

## 3. `model_select` remounts the footer where a repaint would do

`src/index.ts:149` calls `apply(ctx)` on a model change, which tears down the
footer handle, mounts a new one, and re-subscribes to `onBranchChange`.

Nothing about mounting depends on the model. `ctx.model` is a live getter on the
extension runner (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:532`),
and `collectStatusbarData` reads it fresh inside the render callback, so the
existing footer already paints the new model on its next draw.

`thinking_level_select`, two lines below, already does the right thing and calls
`requestRender?.()`.

Fix: `model_select` calls `requestRender?.()`. When no footer is mounted the
optional call is a no-op, which is correct because there is nothing to paint.
`test/extension.test.ts:118` asserts the remount and changes to assert the
repaint instead.

## 4. The panel title calls `theme.fg` unguarded

`src/command.ts:177`:

```ts
container.addChild(new Text(theme.fg("accent", PANEL_TITLE), 1, 1));
```

`src/index.ts:41-63` spends a twelve-line comment explaining why the status
label does not do this. `Theme.fg` throws on a color the loaded theme omits, and
it ignores `NO_COLOR`. That file guards with
`hasThemeColor(ctx.ui.theme, "accent")` and paints through `applyColors`. The
panel makes neither check on the same color name.

`src/colors.ts:281` wraps its own `theme.fg` in try/catch, so this line is the
only unguarded call in the package.

The consequence is smaller than in `session_start`, where a throw would stop the
footer mounting: here it would fail `/statusbar` on a theme without `accent`,
and it paints the title under `NO_COLOR`. It is still the package contradicting
its own documented rule in the one place the rule is not followed.

Fix: route the title through the same ladder the status label uses.

## 5. `/statusbar` registers no argument completions

`pi.registerCommand` accepts `getArgumentCompletions`
(`dist/core/extensions/types.d.ts:895`) and the guidelines list it alongside the
handler. `src/command.ts:360` registers a description and a handler only.

Every argument the command takes is a closed set that the package already
exports: `PRESET_VALUES`, `SEPARATOR_VALUES`, `ICON_MODE_VALUES`, `SCHEME_NAMES`.
Today a user has to read `USAGE` to learn that twelve scheme names exist, which
is why `USAGE` says "the panel lists every scheme" instead of naming them.

This is a missing capability rather than a defect. It is last on the list
because the panel already covers the same ground for anyone who types the bare
command.

## Checked, no action

Against the guidelines:

- The factory registers a command and reads config. It starts no process,
  socket, or watcher. Async factories are explicitly allowed for exactly this.
- `session_shutdown` clears both the footer and the status; `session_start`
  reloads config and remounts. State is rebuilt from disk and from the session,
  not from module-level variables.
- UI calls are guarded by `ctx.hasUI`, and the command falls back to text output
  when there is no terminal.
- No stale `ctx` survives a session replacement: the footer closure is replaced
  on every `session_start`.
- `getAgentDir()` comes from the SDK rather than a hardcoded `.pi`, which is
  stronger than the guideline's `CONFIG_DIR_NAME` advice.
- The package registers no tools, so output truncation, `prepareArguments`, and
  the file mutation queue do not apply.
- `peerDependencies` only, no runtime dependencies, so the
  `dependencies`-versus-`devDependencies` rule has nothing to bite on.
- `pi.extensions` names `./src/index.ts` and the package ships raw TypeScript,
  which is what jiti loads.

Reviewed and left alone:

- `AsyncCache` returns stale values, dedupes concurrent refreshes, swallows a
  rejected fetcher so nothing becomes an unhandled rejection, and isolates a
  throwing listener. The git cache key includes the command set, with a comment
  explaining the preset-switch bug that keying on directory alone would cause.
- Config loading treats a missing file as a first run and a malformed file as
  defaults plus one reported warning. Unknown widget types are dropped rather
  than defaulted. Colors that fail to normalize fall back to the spec default.
- `nearestAnsi` degrades hex by hue rather than by RGB distance, and says why
  the obvious answer collapses pastel palettes into white.
- Every line goes through the ANSI-aware `truncateToWidth`, so a cut line never
  strands half an escape sequence.
- The per-frame string work in `applyColors` and `paint` is proportional to the
  number of segments, which is under ten. Not worth touching.

## Suggested order

1 and 2 are independent and both small. 3 is three lines including the test. 4
is a one-line change to an existing helper call. 5 is the only one that adds
surface, and it can wait or be dropped.
