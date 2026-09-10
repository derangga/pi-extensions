# Effect best-practices audit: pi-broodmother

> Status: findings 1, 2, 3, 4 and 6 are implemented in the working tree, uncommitted,
> pending review. Finding 5 was left as is, per its own advice. One deliberate
> remainder: `Settings` stays in `Manager.layer`'s requirements, because the run
> tests swap it for an in-memory fake and a layer that provided its own
> `Settings.layer` would make that fake unreachable.

Audited against the `effect-best-practices` skill (Effect v4, rc.113-era patterns).
Scope: every module under `packages/pi-broodmother/src`. The graph index from
codebase-memory confirmed the caller structure; every finding below was verified
against the actual source.

Verdict up front: this codebase is in unusually good shape for an Effect
extension. Services are `Context.Service` with `make`, errors are
`Schema.TaggedError` and specific, `Effect.fn` is used everywhere, resources go
through `Effect.acquireRelease` and scoped finalizers, and the bridge to Pi's
callback world sits in exactly one file. The findings below are refinements,
not repairs.

## What already follows the skill

- **Services.** `Manager`, `Intercom`, `Settings` are `Context.Service` with
  `make` and a `static layer`. `ParentDelivery` and `ManagerSurfaces` are bare
  context keys, which is the correct shape for callbacks Pi hands over and
  nothing constructs.
- **Errors.** Eleven distinct tagged errors (`EmptyTaskList`, `TooManyTasks`,
  `SelfEdge`, `CyclicGraph`, `ModelNotFound`, `UnknownRun`, ...), each carrying
  the context a formatter needs. No blanket `NotFoundError` anywhere.
- **`Effect.fn`** on every service method and internal step, `Effect.fnUntraced`
  on the two internal builders that need no span.
- **Resources.** `Effect.scoped` around every child run, `acquireRelease` for
  slots, claims and parked queues, `Effect.addFinalizer` for maps and
  unsubscribes. No `try/finally` on the Effect side.
- **Concurrency.** `Effect.forEach` with an explicit `concurrency` setting for
  waves and probes. No `Promise.all` over Effects. `Effect.forkIn(..., scope)`
  for run fibers, with `Effect.ensuring(finish(run))` so a run always settles.
- **Boundary.** One `ManagedRuntime` in `index.ts`, every Pi callback crosses it
  with `runPromise`, typed failures become thrown messages exactly once.
- **Layer names.** `Settings.layer`, `Intercom.layer`, `Manager.layer`. No
  `Default` or `Live`.

## Findings

### 1. Layer wiring happens at the usage site, not in the service layer

> Implemented for Intercom: `Manager.layer` provides `Intercom.layer`
> internally, and `index.ts` provides only the bare push targets plus
> `Settings.layer`. Settings deliberately remains a requirement (see the
> status note at the top).

Severity: medium. File: `src/index.ts` (runtime composition), `src/run.ts`
(`Manager.layer`).

`Manager.layer` is a bare `Layer.effect(this, this.make)`, and the composition
that satisfies it lives in `index.ts`:

```ts
const runtime = ManagedRuntime.make(
  Manager.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Settings.layer, surfaces, Intercom.layer.pipe(Layer.provide(parentDelivery))),
    ),
  ),
);
```

The skill's rule is the opposite: the service's own layer provides its
dependencies, so the app root is a flat merge and the service layer's `R` ends
empty. `Manager.make` genuinely needs `Settings` and `Intercom`, so those
belongs inside its `static layer`. Only the two bare keys (`ParentDelivery`,
`ManagerSurfaces`) belong to whoever embeds the extension, because each embedding
supplies its own.

There is also a second leak. `Manager.start` declares
`Effect.Effect<RunView, StartError, Settings>`, so the Settings requirement
survives all the way to the tool-call boundary, and `index.ts` carries a comment
explaining why the `call` helper has to tolerate it. That requirement comes from
`runGraph` and `resolveTasks` (finding 2), not from anything `start` itself
needs from the context: `start` already reads `settings.current` at the top.

Suggested shape:

```ts
export class Manager extends Context.Service<Manager, ...>()("pi-broodmother/Manager", { make: ... }) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([Settings.layer, Intercom.layer]),
  );
}
```

and in `index.ts`, `Layer.provide` only the two bare keys. `Intercom.layer`
keeps `ParentDelivery` in its own `R` for the same reason: it is bare-key
infrastructure the embedding provides.

Effort: small. No behaviour change, only where the pipes live.

### 2. `Settings` is read from context deep in `graph.ts` and `resolve.ts`

> Implemented. `runGraph` takes `concurrency` and `resolveTasks` takes
> `settings` as arguments; both drop the `Settings` requirement, and
> `Manager.start` no longer carries it in its error-free requirements
> channel. Every knob is now captured when the run starts.

Severity: medium. Files: `src/graph.ts` (`runGraph`), `src/resolve.ts`
(`resolveTasks`).

Both functions do `yield* (yield* Settings).current` internally, which does two
things worth questioning:

- It puts `Settings` in the requirements channel of what should be
  self-contained graph and resolver logic. `planGraph` takes its `limit` as a
  parameter; `runGraph` reaches for the context to get its `concurrency`. The
  two functions in the same file disagree about how settings arrive.
- The caller already has the value. `Manager.start` reads `settings.current`
  before planning, then `runGraph` reads it again at execution time. Nothing
  else in the run re-reads settings, so a mid-run settings change would alter
  wave concurrency but not permissions, maxTasks or maxTurns. That split is
  undocumented and contradicts the package's own stated philosophy in
  `run.ts`, where permissions are captured once so a run stays explainable
  after the fact.

Recommendation: pass `concurrency` into `runGraph` and `settings` into
`resolveTasks` as parameters, exactly like `planGraph`'s `limit`. Both become
pure functions of their arguments, the `Settings` requirement disappears from
`Manager.start`'s signature (which also removes the workaround comment in
`index.ts`), and "captured when the run starts" becomes true of every knob, not
just the ones with a comment about it.

If mid-run liveness is deliberate, say so in one place instead of leaving it
to be discovered.

Effort: small. A couple of signatures and the call sites in `run.ts`.

### 3. `Effect.catch` sites, one of them over `unknown`

> Implemented for the settings read: failures now surface as
> `SettingsReadError { path, message, missing }`, and the ENOENT branch
> matches the `missing` field instead of probing a Node error object.
> The other two catches stand as written, per the analysis below.

Severity: low, one medium. Files: `src/settings.ts:176-183`, `src/resolve.ts:436-441`,
`src/intercom.ts:316-319`.

The skill forbids blanket `Effect.catch` because it discards type information.
Three sites use it:

- `settings.ts` `loadSettings`: `Effect.tryPromise({ catch: (cause) => cause })`
  gives the effect an `unknown` error channel, then a blanket `Effect.catch`
  catches that `unknown` and pattern-matches on it later with
  `isMissingFile(cause)`, a duck-typed `code === "ENOENT"` check. This is the
  weakest of the three: the error channel is untyped, so nothing stops a second
  `Effect.catch` upstream from swallowing a read failure into silence. Fix is
  small: catch into one tagged error at the boundary, e.g.
  `SettingsReadError { cause: Schema.String }` carrying `describeCause(cause)`
  plus a `missing: Schema.Boolean` field decided at catch time. The ENOENT
  branch then matches on a tag instead of a property probe.
- `resolve.ts` `probeAll`: `tryPromise` fails with a `string` message, and the
  pipe converts that failure into success data. The error channel is `string`
  and the conversion is total, so no type information is lost in practice. The
  pipe is a little roundabout (fail with a message, then un-fail it), but it is
  commented and correct. Leave it, or fold the two steps into one `catch` that
  returns the message directly.
- `intercom.ts` `park`: `Queue.takeAll` can only fail with `Cause.Done` (the
  queue ended), and the catch turns that into "nothing to wait for". The error
  type is specific, the handling is the whole point, and the comment explains
  it. This is fine as written; a one-line comment naming `Cause.Done` at the
  catch would make it obvious to a reader who has not memorised the queue API.

### 4. `process.env` in `getSettingsPath`

> Implemented: the path is now `makeSettings(path)`'s argument, with
> `Settings.layer` for the session default and `settingsLayerFor(path)`
> for tests and embeddings, covered by a new test in
> `test/settings.test.ts`. The environment lookup itself stays in
> `getSettingsPath` and appears nowhere else in the package.

Severity: low. File: `src/settings.ts:63`.

```ts
return process.env[CONFIG_ENV] ?? join(getAgentDir(), "extensions", "pi-broodmother.json");
```

The skill's table says `Config.*` over `process.env`. Here that trade is less
clear-cut than usual: this is a Pi extension loaded by jiti into Pi's process,
there is no Effect runtime alive at the moment the path is needed, and
`Settings.make` calls `getSettingsPath()` directly. Standing up a
`ConfigProvider` layer just to read one env var would buy ceremony, not
type safety.

The cheaper improvement is the one the skill is actually pointing at: make the
path an input rather than a module-level read. `Settings.layer` could take the
path as a build argument (or `Settings.make` could accept it), with
`getSettingsPath()` called once in `index.ts`. Tests already thread paths
through `loadSettings`/`saveSettings`, so only the layer construction changes.
If left as is, it is a defensible deviation, but it should be the only
`process.env` in the package, and today it is.

### 5. `runSync` density in the lifecycle event callback

Severity: low, borderline deliberate. File: `src/lifecycle.ts` (the
`session.subscribe` callback, lines ~258-362).

The skill's forbidden list bans `runSync` inside services. These calls are not
that: they sit inside Pi's synchronous `subscribe` callback, outside any fiber,
and every one is commented with the reason. The pattern itself is sound
boundary work.

The refinement is arithmetic. A `turn_end` event performs up to five separate
`runSync` round-trips (`Ref.update` then four `Ref.get`s, plus a conditional
`Ref.set`), and `tool_execution_start` does a `get` followed by a `set` through
two separate `runSync` calls. Each call is a fiber hop. A single
`Ref.make<LifecycleCounters>(...)` holding one struct, updated with one
`Ref.update` and read with one `Ref.get`, would cut each event to one hop and
remove the get-then-report double sync in the tool-call branch. Correctness is
unchanged either way; this is a hot path (per event, sometimes per token), so
the allocation reduction is the actual argument.

If this stays as is, it is acceptable: the comments explain it, and the values
are honest. Just do not add a sixth `runSync` to the same callback.

### 6. Small things

> Implemented: the unnecessary cast and the `layer` -> `kahnLayering`
> rename in `graph.ts`.

- `src/graph.ts`, `runGraph` return: `settlements.sort(...) as readonly
  Settlement[]` is an unnecessary cast; `sort` returns `Settlement[]`, which is
  assignable to the readonly type as is.
- `src/graph.ts`: the wave-assignment helper is named `layer`, which collides
  with the word this package uses for `Layer` everywhere else. `assignWaves`
  or `kahnLayering` would stop a reader from double-taking.
- `src/child.ts` `createChildSession`: plain `async` with a `catch` that shuts
  the session down and rethrows. Not the forbidden `try/finally` pattern; it is
  a promise-side constructor called through `Effect.tryPromise`, and the
  acquired-release responsibility sits correctly in `lifecycle.ts`. No change.
- `src/intercom.ts` `Queue.offerUnsafe` / `Queue.endUnsafe` inside
  `Effect.sync`: safe by construction, since the surrounding `Effect.sync`
  runs them on the fiber. Commented. No change.
- `src/run.ts` `clock.currentTimeMillisUnsafe()` in the `onActivity` callback:
  the captured `Clock` makes this testable and the comment explains why a
  generator cannot live there. Correct use of the escape hatch.

## Suggested order of work

1. Finding 2: thread `concurrency` and `settings` through as parameters. This
   unblocks finding 1's cleanest form.
2. Finding 1: move `Layer.provide` into `Manager.layer` and `Intercom.layer`,
   leaving only the bare keys for `index.ts`.
3. Finding 3: tag the settings read failure; leave the other two catches.
4. Findings 4 and 6: path as layer input, the two nits in `graph.ts`.
5. Finding 5 only if a profile or a sixth `runSync` ever justifies it.

Every step is behaviour-preserving. Run `npm run check` after each; the test
suite already covers the graph, lifecycle, intercom and settings paths these
touch.
