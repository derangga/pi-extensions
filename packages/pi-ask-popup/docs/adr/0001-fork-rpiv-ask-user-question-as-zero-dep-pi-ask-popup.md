# 0001 Fork rpiv-ask-user-question as the zero-dependency pi-ask-popup

Pi had no Claude-Code-style questionnaire dialog, and the closest existing
package, `pi-ask-user`, takes a different shape (a searchable split-pane
selector, no tabs, no previews). We fork juicesharp's
`@juicesharp/rpiv-ask-user-question`, strip it to zero runtime dependencies,
and publish it as `pi-ask-popup` 0.1.0. These decisions were settled before any
code was ported, so the notes below record the evidence behind them.

## Identity

- npm `pi-ask-popup`, unscoped, starting at 0.1.0. The name was verified free
  on npm; `pi-ask-user` is taken by the similar package noted above.
- The package lives at `packages/pi-ask-popup/` in this workspaces monorepo.
  Shared tooling (tsconfig base, oxlint, oxfmt, vitest config) sits at the
  root, and root scripts are scoped to `packages/` so the vendored reference
  clones never get linted, formatted or tested. Pi peer dependencies are also
  root devDependencies pinned at one exact version, so every package
  typechecks against the same Pi while peering the wider range.
- Author `derangga <derangga1011@gmail.com>`. The LICENSE is MIT carrying
  juicesharp's original copyright line plus derangga's, as the MIT terms
  require of a fork.
- Ships raw TypeScript. Pi resolves `"pi": { "extensions": ["./src/index.ts"] }`
  and loads it through jiti. No build step, no `dist/`. Layout is `src/` plus
  `test/`.

## Dependencies

Zero runtime dependencies. Peers only: `@earendil-works/pi-coding-agent
>=0.80`,`@earendil-works/pi-tui >=0.80`,`typebox *`.

The peer is `typebox`, never `@sinclair/typebox`. Pi 0.84.4 depends on
`typebox@1.3.7`; the old name is a different package that Pi never loads, so
peering it would silently resolve to something unused.

## Considered options

**Effect, rejected.** `effect@3.22.1` is 27 MB unpacked, larger than Pi's own
coding agent, against a zero-dep goal and a 114 kB competitor. Effect v4,
which the house style targets, is still a release candidate with no stable
release. The ported code has three async edges in total, so failure is
modeled as tagged unions instead: Effect-shaped, no import.

**rpiv-config and rpiv-i18n, dropped.** The fork drops both dependencies, the
i18n bridge, all nine locale files, and their tests. The 2-second prewarm
timer goes with them.

**Kept.** The pure reducer and key router, the tabbed multi-question dialog,
the Submit review tab, side-by-side markdown previews, multi-select with the
`Next` row, the appended `Type something.` row, per-question and global
notes, collapse mode on `Ctrl+]`, the RPC/ACP dialog walker, the `no_ui`,
`no_custom_ui`, `session_load_failed` and `stale_module_cache` envelopes, and
every test covering a surviving feature.

## Pi compatibility

Verified by diffing the published `.d.ts` of Pi 0.80.6 and 0.84.4:

- `ui.select`, `ui.input`, `ui.custom`, `ui.onTerminalInput`, `ctx.mode` and
  `ctx.hasUI` are identical in both versions.
- `OverlayHandle` (hide/setHidden/isHidden/focus/unfocus) is byte-identical at
  the same line numbers in pi-tui 0.80.6 and 0.84.4, so collapse mode ports
  untouched.
- 137 lines changed elsewhere in `core/extensions/types.d.ts` between the
  versions; none are in the surface this package uses. The `>=0.80` peer
  range is therefore safe.
- `ExtensionUIDialogOptions` already carries `timeout?: number`, documented
  as auto-dismissing with a live countdown display, in both versions. The RPC
  path passes timeout through; only the TUI overlay needs a hand-built clock.

## Added

`timeout`, with a distinct `timed_out` result that is never folded into
`cancelled`. The reasoning matches why `no_custom_ui` is its own envelope: a
timeout is not a decline, and the model must not read it as one.

## Consequences

The two load-failure envelopes stay even though the prewarm timer goes. jiti
is pinned at 2.7.0 in both Pi versions, so the cache-poisoning bug they guard
against is still live: a failed import stays registered in the module graph
cache and poisons every later import for the process lifetime.

Out of scope: no searchable option filter (the schema caps options at four),
no cross-session answer memory, no CI, no changesets, no built `dist/`, and
no raised caps on questions or options.

One question is deliberately deferred. The `"Other"` label stays in the
reserved-label list purely because Claude Code conditions models to reach for
it. It is worth keeping only as long as tool-name parity is the goal.
