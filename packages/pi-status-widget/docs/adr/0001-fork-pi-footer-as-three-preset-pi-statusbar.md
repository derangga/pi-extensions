# 0001 Fork pi-footer as the three-preset pi-statusbar

Pi's footer ecosystem already has three entries. wobondar's `pi-footer` is the
capable one: 56 widgets, 9 presets, an in-terminal config editor of 1,868 lines
across 26 files, and chalk as a runtime dependency. The unscoped
`pi-statusline` on npm is hsingjui's, and `@narumitw/pi-statusline` is a third
author's again. None of them colors the thinking segment by thinking level,
which is the feature this package exists to add.

We fork `pi-footer`, strip it to three presets and 14 widgets, remove its one
runtime dependency, and publish it as `pi-statusbar` 0.1.0. These decisions were
settled before any code was ported, so the notes below record the evidence
behind them.

## Identity

- npm `pi-statusbar`, unscoped, starting at 0.1.0. The name was verified free on
  npm. `pi-statusline` and `pi-bar` are taken.

  **Amendment, first publish attempt:** unscoped `pi-statusbar` had been taken
  by someone else in the time between that check and shipping. Published as
  `pi-status-widget` 0.1.0 instead, still unscoped, and the directory moved to
  `packages/pi-status-widget/` to match. The internal status label and command
  name printed in the footer stay `pi-statusbar`, since that string is display
  text, not the npm package name or the directory.
- The package lives at `packages/pi-status-widget/` in this workspaces
  monorepo (`packages/pi-statusbar/` before the amendment above). Shared
  tooling sits at the root, and root scripts are scoped to `packages/` so the
  vendored reference clones never get linted, formatted or tested.
- Author `derangga <contact@rangga.site>`. The LICENSE is MIT carrying
  wobondar's original copyright line plus derangga's, as the MIT terms require
  of a fork.
- Ships raw TypeScript. Pi resolves `"pi": { "extensions": ["./src/index.ts"] }`
  and loads it through jiti. No build step, no `dist/`. Layout is `src/` plus
  `test/`.
- One slash command, `/statusbar`. Bare invocation prints state and the config
  file path; arguments set the preset, the icon mode, or the enabled flag.

## Dependencies

Zero runtime dependencies. Peers only: `@earendil-works/pi-coding-agent >=0.80`
and `@earendil-works/pi-tui >=0.80`.

No `typebox` peer, unlike the sibling package in this monorepo. This extension
registers no tool, so it never builds a schema.

chalk is gone. Upstream uses it only for 256-color, truecolor and bold output,
and already hand-rolls the 16-color path itself. Those escape codes are about
30 lines to emit directly, which is cheaper than the dependency this repo
forbids anyway.

## Scope

**Kept.** The `WidgetSpec` architecture and its dependency slicing, so a widget
still receives only the data keys it declares. The render pipeline with its
separator joining, flex split and width truncation. The git
stale-while-revalidate cache, so a render never blocks on a subprocess. The
session metrics parser with its deliberately loose runtime-validated
projections of Pi's session entries. The three preset layouts, verbatim in
widget content.

**Dropped.** The config TUI, 26 files and a quarter of upstream's 7,560 source
lines. The five powerline presets and the segment and cap helpers that build
them. 42 widgets, including the whole speeds family, the 361-line project
runtime detector, and the layout widgets other than flex-separator. The
text-verbosity widget. The event-widget channel. ansi256 colors and the digit
picker that edited them. The terminal width mode. The global minimalist flag.

Two smaller strips worth naming, because both look like features and are not.
Widget option metadata collapses to id, kind, default and choices: the labels,
descriptions, `showWhen` guards and `showIn*` flags existed only to drive
the field editors and pickers that are gone. And the `text` icon mode goes
while the per-widget `text` base option stays. Upstream gave two unrelated
things the same name, one being a word-label icon set and the other the
fallback string for an empty value.

## Pi compatibility

Verified by diffing the published `.d.ts` of Pi 0.80.6 against 0.84.4:

- `ctx.ui.setFooter` and `ReadonlyFooterDataProvider`, with its `getGitBranch`,
  `onBranchChange` and `getExtensionStatuses`, are byte-identical in both.
- `ctx.getContextUsage`, `pi.getThinkingLevel`, `Theme.fg` and
  `Theme.getThinkingBorderColor` are identical in both.
- Pi's changelog dates the true floor lower still: `setFooter` arrived in
  0.37.3, the footer data provider in 0.42.2, and `getContextUsage` in 0.49.0.
  Nothing below 0.49 could work at all.

One real difference turned up in the same diff, and it lands directly on the
feature this package adds. In 0.80.6 a `Theme` constructor requires every
color, so every theme defines `thinkingMax`. From 0.84 both `thinkingMax` and
`searchMatchText` became optional, while `Theme.fg` still throws on a color the
loaded theme does not define. A direct level-to-theme-color lookup therefore
crashes the footer on a 0.84-era theme that omits `thinkingMax`. The `>=0.80`
peer range is safe only because the thinking color falls back instead of
looking up blindly.

## Added

**Thinking-level color.** The thinking segment takes its color from the level,
mapped to the theme colors Pi already uses for its own thinking indicator, so
the footer agrees with the rest of the UI under a custom theme. Two fallback
layers sit behind it: a fixed ANSI palette when the theme lacks that color, and
the widget's configured foreground when there is no theme at all, which is the
case on the command path. On by default in every preset, switchable off per
widget.

**A repaint that makes it work.** Upstream never subscribes to Pi's
`thinking_level_select` event, so a level change reaches the footer only on the
next unrelated redraw. For a color whose whole job is tracking that level, this
package subscribes and requests a render.

## Considered options

**Depend on pi-footer instead of forking, rejected.** It has no extension API
for third-party presets, and it pulls chalk, which this repo forbids.

**Clean rewrite, rejected.** It would discard the git cache, the metrics parser
and the icon and hide-rule composition, all of which are fiddly and already
correct upstream. Porting also keeps the diff against upstream readable if a
fix is worth pulling later.

**Keep the config TUI, rejected.** Three presets is a small enough space that a
picker beats a builder. The TUI exists upstream because 57 widgets and 9 presets
need one, and it is where most of a footer package's maintenance burden lives.

**`Theme.getThinkingBorderColor`, rejected.** Pi's own level-to-color mapping is
tempting and would track upstream automatically, but it returns a colorizer
function rather than a color name, so it fights the renderer's foreground,
background and bold composition. It also calls `fg("thinkingMax")` internally,
which inherits the crash described above instead of fixing it.

**`process.stdout.isTTY` for color detection, rejected.** It is one of the three
places Bun and Node actually diverge, and this code has to run on both. The
`NO_COLOR` environment variable needs no runtime feature detection and is the
cross-ecosystem convention.

**A one-second timer to animate the elapsed-time segment, rejected.** It would
repaint the footer every second for the whole session to animate a number nobody
watches, and it must be torn down correctly on every dispose path or it leaks
across sessions.

## Consequences

Presets carry a separator and a widget list, nothing more. An explicit icon
choice persists and a preset switch never overwrites it, because a font
capability belongs to the terminal rather than to a layout. The visible cost is
that git-heavy, which upstream designed around nerd-font branch and commit
glyphs, renders emoji until the user asks for nerd.

A malformed config file falls back to defaults and notifies, where upstream
rethrows anything that is not `ENOENT` and so fails the extension load. A
statusline is not worth a failed load.

Hand-edited configs lose ansi256 colors along with the picker that produced
them. Named colors and `pi:<themeColor>` remain.

The elapsed-time segment is accurate whenever the footer draws and occasionally
stale between draws. This is upstream's behavior, now deliberate rather than
incidental.

Git collection diverges from upstream on purpose: the command set is derived
from the enabled git widgets, so the default and compact presets run three
subprocesses instead of seven and `remote get-url origin` never runs at all.
Upstream git fixes will need adapting rather than copying.

One detail is deliberately deferred. The nerd glyph for the thinking segment
keeps upstream's placeholder until the intended one is pinned down by codepoint.
