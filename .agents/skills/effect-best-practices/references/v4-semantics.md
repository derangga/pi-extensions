# v4 Semantics

Core behaviors in Effect v4 that shape daily code. Each section describes the meaning and the pattern to use.

## Yieldable: Ref, Deferred, and Fiber Are Not Effects

The **Yieldable** trait permits `yield*` in generators without making the type assignable to `Effect`.

```typescript
interface Yieldable<Self, A, E = never, R = never> {
    asEffect(): Effect<A, E, R>
    [Symbol.iterator](): EffectIterator<Self>
}
```

### Yieldable values

`Effect`, `Option` (fails with `NoSuchElementError`), `AsyncResult` (fails with its error), `Config` (fails with `ConfigError`), `Context.Service` (yields the service).

### Not Effects, use the module function

```typescript
// WRONG, not Effects
const value = yield* ref
const result = yield* deferred
const output = yield* fiber

// CORRECT
const value = yield* Ref.get(ref)
const result = yield* Deferred.await(deferred)
const output = yield* Fiber.join(fiber)
```

### Combinators need an explicit `.asEffect()`

`yield*` works on any `Yieldable`, but passing one to a combinator does not:

```typescript
// Option is not assignable to Effect
const program = Effect.map(Option.some(42).asEffect(), (n) => n + 1)

// ...or use a generator, which is idiomatic
const program = Effect.gen(function* () {
    const n = yield* Option.some(42)
    return n + 1
})
```

**Why it matters:** `Effect.all([refA, refB])` with an array of `Ref`s is a compile error. Read each ref explicitly with `Ref.get`.

## Equality Is Structural by Default

`Equal.equals` uses structural equality for plain objects and arrays:

```typescript
// All true.
Equal.equals({ a: 1 }, { a: 1 })
Equal.equals([1, [2, 3]], [1, [2, 3]])
Equal.equals(new Map([["a", 1]]), new Map([["a", 1]]))
Equal.equals(new Set([1, 2]), new Set([1, 2]))
```

Plain objects, arrays, `Map`, `Set`, `Date`, and `RegExp` are compared by value. Types implementing the `Equal` interface keep their custom logic.

`Equal.equals(NaN, NaN)` is `true`.

### Opting out

```typescript
const obj = Equal.byReference({ a: 1 })
Equal.equals(obj, { a: 1 }) // false
```

- `byReference(obj)` returns a `Proxy` using reference equality; the input object keeps its own identity.
- `byReferenceUnsafe(obj)` marks the object itself; faster, but permanently changes how that object compares.

Use `Equal.asEquivalence()` to derive an `Equivalence` from structural equality.

**Watch for this** in caches, `Set`/`Map` keys, and dedup logic where two identical-looking objects collapse into one entry.

## Fiber Keep-Alive Is Built In

The runtime holds the Node process open while a fiber is suspended, using a reference-counted keep-alive timer. This works with plain `Effect.runPromise`:

```typescript
const program = Effect.gen(function* () {
    const deferred = yield* Deferred.make<string>()
    yield* Deferred.await(deferred) // process stays alive
})

Effect.runPromise(program)
```

**`runMain` is recommended** for application entry points:

- **Signal handling.** `SIGINT` / `SIGTERM` gracefully interrupt the root fiber
- **Exit codes.** Calls `process.exit(code)` on failure or signal
- **Error reporting.** Reports unhandled errors

Use `runMain` for any real application entry point. Scripts and tests stay alive until fibers complete.

## Unstable Modules

`effect/unstable/*` holds modules under active development. Modules outside `unstable/` follow **strict semver**; modules inside it **may receive breaking changes in minor releases**.

Currently unstable: `ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `httpapi`, `jsonschema`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workflow`, `workers`.

These are standard import paths. Modules graduate to the top-level `effect/*` namespace as they stabilize.

Practical consequences:

- Pin your Effect version if you depend heavily on `unstable/` modules. HTTP, RPC, cluster, and atom code is the most exposed.
- Expect import paths to change on graduation. A module moving from `effect/unstable/http` to `effect/http` keeps the same API under the top level path.
- All Effect ecosystem packages share **one version number**. `effect`, `@effect/sql-pg`, `@effect/atom-react`, `@effect/vitest` must all be on the same version.

## Other Core Behaviors

**Layer memoization is shared across `Effect.provide` calls.** Overlapping layers reuse the same instance. Opt out with `Layer.fresh` or `Effect.provide(layer, { local: true })` for a separate instance. See `layer-patterns.md`.

**`Cause` is flat.** A `Cause` wraps `reasons: ReadonlyArray<Reason>` where `Reason` is `Fail | Die | Interrupt`. See `error-patterns.md`.

Use `Context<R>` and `Effect.runForkWith(services)` for runtime composition. The `Runtime` module holds `Teardown`, `defaultTeardown`, and `makeRunMain`. See `resource-patterns.md`.

**`Effect.gen` takes `self` in an options object.** Use `Effect.gen({ self: this }, fn)`.

Fiber-local state is `Context.Reference`, read by yielding it and set with `Effect.provideService`. Built-ins live in the `References` module (`References.CurrentLogLevel`, `References.MinimumLogLevel`, ...). See `service-patterns.md`.
