# Stream Patterns

> **Effect v4.** Streams are lazy, pull based compositions of `Effect` steps. A
> `Stream<A, E, R>` emits many `A` values, can fail with `E`, and can require
> services `R` while it is being consumed. Import with:
> `import { Stream } from "effect"`.

## Building streams

### Finite sources

```typescript
import { Stream } from "effect"

const s1 = Stream.make(1, 2, 3)            // fixed values
const s2 = Stream.fromArray([1, 2, 3])     // from an array
const s3 = Stream.fromIterable(map, { chunkSize: 64 })  // from any Iterable
const s4 = Stream.range(1, 10)             // integers, both endpoints included
const s5 = Stream.succeed("one")           // exactly one value
const s6 = Stream.empty                    // no values
```

`Stream.fromIterable` accepts any `Iterable` and an optional `{ chunkSize }`
that controls how many elements are pulled per internal batch.

### Effect sources

```typescript
import { Effect, Stream } from "effect"

// One value, then the stream ends
const user = Stream.fromEffect(fetchUser(42))

// Effect producing an iterable of values
const rows = Stream.fromIterableEffect(loadRows())
```

### Generated sources

```typescript
import { Effect, Option, Stream } from "effect"

// Effectful unfold. Return undefined to stop
const pages = Stream.unfold(0, (page) =>
  Effect.map(fetchPage(page), (res) =>
    res.hasMore ? [res.items, page + 1] : undefined,
  ),
)

// Pure, infinite iteration
const counters = Stream.iterate(0, (n) => n + 1)

// Paginated batches, the next state is an Option so none ends the stream
const batches = Stream.paginate(0, (page) =>
  Effect.map(fetchPage(page), (res) =>
    res.next
      ? [res.items, Option.some(res.next)] as const
      : [res.items, Option.none<number>()] as const,
  ),
)
```

### Scheduled, queue and pubsub sources

```typescript
import { Schedule, Stream } from "effect"

const ticks = Stream.fromSchedule(Schedule.spaced("1 second"))  // schedule outputs
const fromQ = Stream.fromQueue(queue)    // Queue.Dequeue, drains until the end
const fromPS = Stream.fromPubSub(pubsub) // values published to the PubSub
```

`Stream.fromQueue` and `Stream.fromPubSub` are the bridge to the concurrency
primitives. See [Queue] and [PubSub] in `concurrency-patterns.md`.

### Async iterable sources

```typescript
// onError converts unknown async iteration failures into the stream error type
const bytes = Stream.fromAsyncIterable(webStream, (e) => new HttpError(e))
```

## Consuming streams

Streams are pull based. Nothing runs until a consumer pulls, and a stream is
consumed once per run. Running it again re-executes the whole pipeline from the
source.

| Function | Returns | Notes |
| ---------- | --------- | ------- |
| `Stream.runCollect` | `Effect<Array<A>, E, R>` | All elements as one array |
| `Stream.runDrain` | `Effect<void, E, R>` | Discard all elements |
| `Stream.runForEach` | `Effect<void, E2 \| E, R2 \| R>` | Run an effect per element |
| `Stream.runFold` | `Effect<Z, E, R>` | Pure fold over elements |
| `Stream.runFoldEffect` | `Effect<Z, E2 \| E, R2 \| R>` | Effectful fold |
| `Stream.runHead` | `Effect<Option<A>, E, R>` | First element or none |
| `Stream.runLast` | `Effect<Option<A>, E, R>` | Last element or none |
| `Stream.runCount` | `Effect<number, E, R>` | Number of elements |
| `Stream.runSum` | `Effect<number, E, R>` | Sum of a number stream |
| `Stream.mkString` | `Effect<string, E, R>` | Join a string stream |

```typescript
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const all = yield* Stream.runCollect(Stream.make(1, 2, 3))   // [1, 2, 3]
  yield* Stream.runDrain(Stream.make(1, 2, 3))                 // discard values
  yield* Stream.runForEach(
    Stream.make("a", "b"),
    (a) => Effect.log(a),
  )
  const total = yield* Stream.runFold(
    Stream.make(1, 2, 3),
    () => 0,
    (acc, n) => acc + n,
  )                                                            // 6
  const head = yield* Stream.runHead(Stream.make(1, 2))        // Option.some(1)
  const none = yield* Stream.runHead(Stream.empty)             // Option.none()
})
```

Each run is independent. Side effects inside the stream run again on every
consumption.

```typescript
const doubled = Stream.fromIterable([1, 2, 3]).pipe(
  Stream.map((n) => n * 2),
)

// Every runCollect pulls the source again
const first = yield* Stream.runCollect(doubled)   // [2, 4, 6]
const second = yield* Stream.runCollect(doubled)  // [2, 4, 6], full re-run
```

## Transformations

```typescript
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const values = yield* Stream.make(1, 2, 3, 4).pipe(
    Stream.filter((n) => n % 2 === 0),      // [2, 4]
    Stream.map((n, i) => `${i}:${n}`),      // map receives index too
    Stream.runCollect,
  )
  values // => ["0:2", "1:4"]
})
```

| Combinator | Behavior |
| ------------ | ---------- |
| `Stream.map(f)` | Transform, `f(a, i)` receives the index |
| `Stream.mapEffect(f)` | Transform with an effect |
| `Stream.filter(p)` | Keep elements satisfying the predicate |
| `Stream.filterEffect(f)` | Effectful predicate |
| `Stream.filterMap(f)` | Transform and drop in one step |
| `Stream.take(n)` | First `n` elements |
| `Stream.drop(n)` | Skip the first `n` elements |
| `Stream.takeWhile(f)` | Take while the predicate holds |
| `Stream.takeUntil(f)` | Take up to and including the matching element |
| `Stream.dropWhile(f)` | Skip while the predicate holds |
| `Stream.flatMap(f, options?)` | Map to child streams and flatten |
| `Stream.groupAdjacentBy(keyOf)` | Group consecutive equal keys |
| `Stream.grouped(n)` | Fixed size batches |
| `Stream.groupedWithin(n, d)` | Batches by size or time |
| `Stream.mapAccum(() => s, f)` | Stateful transform, initial state is a thunk |
| `Stream.scan(s, f)` | Running accumulation |
| `Stream.chunks` | Expose internal batches |
| `Stream.rechunk(n)` | Rebalance batch sizes |

Notes:

- `takeUntil` includes the element that matched. Pass `{ excludeLast: true }` to
  drop it.
- `groupAdjacentBy` emits `readonly [K, NonEmptyArray<A>]` for each run of
  consecutive elements sharing a key.
- `mapAccum` receives `initial` as a `LazyArg<S>`, so write `Stream.mapAccum(() => 0, f)`, not
  `Stream.mapAccum(0, f)`. `f` returns `readonly [state, values]`, where `values` is an array of
  emitted outputs. An optional `{ onHalt }` decides what to emit when the stream halts.
  `Stream.scan(initial, f)` takes a plain value, not a thunk.
- `Stream.chunks` returns a stream of `NonEmptyReadonlyArray<A>` batches. Use it
  when batch boundaries matter. Otherwise let combinators handle chunking
  transparently.

`take` and `drop` are pull safe on infinite streams because they stop or skip
without evaluating the rest of the source.

## Effects in streams

`mapEffect` maps with an effect and accepts `{ concurrency, unordered }`:

```typescript
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const results = yield* Stream.fromIterable(userIds).pipe(
    Stream.mapEffect((id) => fetchUser(id), { concurrency: 5 }),
    Stream.runCollect,
  )
  return results
})
```

Other effectful combinators: `filterEffect`, `dropWhileEffect`, `takeWhileEffect`,
`takeUntilEffect`, `mapAccumEffect`, `scanEffect`, `tap`, `tapEffect`. There is
no `Stream.toEffect`. Inside `Effect.gen`, consume streams with the run family:

```typescript
const program = Effect.gen(function* () {
  const users = yield* Stream.runCollect(fetchAllUsers())
  yield* Stream.runDrain(auditLog())
  return users
})
```

For low level control, `Stream.toPull` (requires a `Scope`) gives an
`Effect` that returns one batch per call, and `Stream.fromPull` builds a stream
from such an effect. See `v4-semantics.md` for the pull model.

## Combining streams

```typescript
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const xs = Stream.make(1, 2, 3)
  const ys = Stream.make("a", "b")

  const pairs = yield* Stream.zip(xs, ys).pipe(Stream.runCollect)
  pairs // => [[1, "a"], [2, "b"]]
})
```

| Combinator | Behavior |
| ------------ | ---------- |
| `Stream.merge(self, that, options?)` | Interleave both sources concurrently |
| `Stream.mergeAll(streams, { concurrency, bufferSize? })` | Merge many streams |
| `Stream.mergeLeft` / `Stream.mergeRight` | Merge keeping one side's values |
| `Stream.mergeEffect(effect)` | Merge a stream with a background effect |
| `Stream.zip(self, that)` | Pointwise pairs, ends when either side ends |
| `Stream.zipWith(self, that, f)` | Pointwise combine with a function |
| `Stream.zipLatest(self, that)` | Latest values from both sides |
| `Stream.zipLatestWith(self, that, f)` | Latest values with a function |
| `Stream.concat` | All of one stream, then the next |
| `Stream.interleave` | Alternate elements |
| `Stream.race` / `Stream.raceAll` | First stream to emit wins |
| `Stream.combine(self, that, s, f)` | Custom pull based combination |
| `Stream.combineArray` | Combination over batches |

`merge` runs both streams and emits values as they arrive. When one side ends,
the merged stream continues with the other. Use
`options: { haltStrategy }` with `"left"`, `"right"`, `"both"`, or `"either"` to
control how failures propagate.

To process each element through a child stream with parallelism, use
`flatMap` with the concurrency option:

```typescript
const processed = Stream.fromIterable(paths).pipe(
  Stream.flatMap((path) => readFile(path), { concurrency: 10 }),
)
```

There is no separate concurrent flat map combinator. `flatMap` with
`{ concurrency: number | "unbounded" }` and an optional `bufferSize` covers it.
`switchMap` is the variant that cancels the previous child stream when a new
element arrives.

## Concurrency and backpressure

Streams are pull based, so backpressure is the default: a slow consumer pulls
at its own pace and the producer waits. Add a buffer only when a producer
should progress ahead of the consumer.

```typescript
import { Stream } from "effect"

// Bounded buffer, apply backpressure when full
const buffered = source.pipe(Stream.buffer({ capacity: 64 }))

// Strategies: "dropping" drops new chunks, "sliding" drops old ones,
// "suspend" applies backpressure
const dropping = source.pipe(
  Stream.buffer({ capacity: 64, strategy: "dropping" }),
)

// Unbounded buffer, producer never waits
const unbounded = source.pipe(Stream.buffer({ capacity: "unbounded" }))
```

| Combinator | Purpose |
| ------------ | --------- |
| `Stream.buffer({ capacity, strategy? })` | Decouple producer from consumer |
| `Stream.broadcast(options)` | Fan out to independent streams, requires `Scope` |
| `Stream.share(options)` | Multiple consumers share one source |
| `Stream.debounce(d)` | Emit only after a quiet period |
| `Stream.throttle({ cost, units, duration })` | Rate limit by cost |
| `Stream.switchMap(f)` | Cancel the previous child on each element |

`Stream.broadcast` returns an `Effect` producing several `Stream` values backed
by one shared source. `Stream.share` does the same for many consumers with
options for capacity, strategy, replay, and `idleTimeToLive`. See
[Queue] and [PubSub] in `concurrency-patterns.md` for the queue variants
(`"dropping"`, `"sliding"`, `"suspend"`) these options reuse.

## Sinks

A `Sink<A2, A, L, E2, R2>` consumes a stream and produces one result. Common
sinks:

```typescript
import { Effect, Sink, Stream } from "effect"

const program = Effect.gen(function* () {
  // Sink.collect builds an array
  const collected = yield* Stream.run(Stream.make(1, 2, 3), Sink.collect<number>())

  // Sink.fold folds with an effect, contFn decides when to stop.
  // The initial state is a thunk, not a value
  const sum = yield* Stream.run(
    Stream.make(1, 2, 3),
    Sink.fold(() => 0, () => true, (acc, n) => Effect.succeed(acc + n)),
  )

  // Sink.forEach runs an effect per element
  yield* Stream.run(Stream.make(1, 2), Sink.forEach((n) => Effect.log(n)))
})
```

The run family covers most needs. Reach for explicit sinks when a consumer
needs leftovers or early exit.

## Scheduling, retry and time

```typescript
import { Duration, Schedule, Stream } from "effect"

// Repeat the whole stream on a schedule after it completes
const polling = source.pipe(
  Stream.repeat(Schedule.spaced(Duration.seconds(5))),
)

// Repeat forever
const endless = source.pipe(Stream.forever)

// Stream of schedule outputs, no source needed
const ticks = Stream.fromSchedule(Schedule.spaced(Duration.seconds(1)))

// Emit void at an interval
const beat = Stream.tick(Duration.seconds(1))
```

`Stream.retry` takes a `Schedule` whose input is the stream error:

```typescript
const resilient = Stream.fromQueue(events).pipe(
  Stream.retry(
    Schedule.exponential(Duration.millis(100)).pipe(
      Schedule.upTo({ times: 5 }),  // bound the number of attempts
    ),
  ),
)
```

`Stream.timeout(d)` ends the stream when no element arrives within the
duration. It does not fail. Use `Stream.timeoutOrElse({ duration, orElse })` to
switch to a fallback stream instead:

```typescript
const withFallback = slowSource.pipe(
  Stream.timeoutOrElse({
    duration: Duration.seconds(3),
    orElse: () => Stream.make("default"),
  }),
)
```

The timeout applies per pull. After switching, the fallback stream is not
timed.

## Text and bytes

```typescript
import { Stream } from "effect"

declare const body: Stream.Stream<Uint8Array, HttpError>

const lines = body.pipe(
  Stream.decodeText(),        // Stream<Uint8Array, E> to Stream<string, E>, takes { encoding }
  Stream.splitLines,          // not curried, pass the function itself
  Stream.runCollect,
)
```

`Stream.decodeText` accepts an optional `{ encoding }`. The inverse is
`Stream.encodeText`, which turns a string stream into `Uint8Array` chunks.
`Stream.limitBytes` caps byte volume and switches to a fallback stream, and
`Stream.mkUint8Array` collects a byte stream into one array.

## Scoped resources

Streams compose with `Effect.acquireRelease` and `Scope`. Wrap scoped effects
with `Stream.scoped` so finalizers run when the stream finishes:

```typescript
import { Effect, Stream } from "effect"

const stream = Stream.scoped(
  Stream.fromEffect(
    Effect.acquireRelease(
      connect(),
      (conn) => conn.close().pipe(Effect.orDie),
    ),
  ).pipe(
    Stream.flatMap((conn) => Stream.fromAsyncIterable(conn.rows(), (e) => new DbError(e))),
  ),
)
```

`Stream.scoped` removes the `Scope` requirement and guarantees release on
success, failure, and interruption. See [Cleanup Guarantees] in
`resource-patterns.md` for the release guarantees.

Useful combinators around scopes:

| Combinator | Purpose |
| ------------ | --------- |
| `Stream.scoped(self)` | Run a `Scope` requiring stream inside a managed scope |
| `Stream.ensuring(finalizer)` | Run an effect after the stream finishes either way |
| `Stream.unwrap(effect)` | Build a stream from an effect returning a stream |
| `Stream.suspend(lazy)` | Defer construction until the first pull |
| `Stream.toPull` | Low level pull loop, requires `Scope` |
| `Stream.toQueue(options)` | Bridge to a `Queue.Dequeue`, requires `Scope` |
| `Stream.toPubSub(options)` | Bridge to a `PubSub`, requires `Scope` |
| `Stream.peel(sink)` | Consume one sink, return the rest as a stream |

`Stream.toQueue` and `Stream.toPubSub` produce scoped handles that end with a
`Cause.Done` signal when the stream completes:

```typescript
import { Cause, Effect, Queue, Stream } from "effect"

const program = Effect.scoped(
  Effect.gen(function* () {
    const queue = yield* Stream.toQueue(Stream.make(1, 2, 3), {
      capacity: "unbounded",
    })
    const value = yield* Queue.take(queue)
    yield* Effect.log(value)
  }),
)
```

There is no `Stream.toIterable`. To consume outside Effect, use
`Stream.toAsyncIterable` for streams without services, `Stream.toAsyncIterableWith`
with a `Context`, or `Stream.toReadableStream` on the platform.

## Errors

The error channel `E` carries ordinary failures. End of stream is not a
failure: sources signal completion through `Cause.Done` internally. `Stream.fromQueue`
excludes `Cause.Done` from its error type, and `Stream.toQueue` appends it when
the stream ends.

```typescript
import { Effect, Stream } from "effect"

class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly resource: string) {}
}

class Unauthorized {
  readonly _tag = "Unauthorized"
  constructor(readonly user: string) {}
}

const program = Effect.gen(function* () {
  const result = yield* Stream.fail(new NotFound("profile")).pipe(
    Stream.catchTags({
      NotFound: () => Stream.succeed("fallback"),
      Unauthorized: () => Stream.succeed("login"),
    }),
    Stream.runCollect,
  )
  result // => ["fallback"]
})
```

| Combinator | Purpose |
| ------------ | --------- |
| `Stream.fail(e)` | Fail the stream with a value |
| `Stream.catchTag(tag, f)` | Handle one tagged error, f returns a stream |
| `Stream.catchTags(cases)` | Handle several tagged errors |
| `Stream.catchIf(predicate, f)` | Handle errors matching a predicate |
| `Stream.catchCause(f)` | Handle the full `Cause` |
| `Stream.mapError(f)` | Transform the error |
| `Stream.onError(cleanup)` | Run an effect on failure with the `Cause` |
| `Stream.onExit(f)` | Run an effect when the stream exits either way |
| `Stream.orDie` | Remove the error channel by dying |

`Stream.onError` receives the `Cause` and can log or report. See
`error-patterns.md` for `Cause` and tagged error design.

## Anti-patterns

> See also: `anti-patterns.md` for the general catalog

### Consuming a stream twice expecting shared state

```typescript
// WRONG: each run re-executes the pipeline, the counter restarts every time
const stream = Stream.fromEffect(Ref.get(counter))

// FIX: use share for many consumers over one source, or broadcast for fan out
const shared = source.pipe(Stream.share({ capacity: 64 }))
```

### Collecting an infinite stream

```typescript
// WRONG: runCollect on an infinite stream never finishes
const all = yield* Stream.runCollect(Stream.iterate(0, (n) => n + 1))

// FIX: bound the stream with take, or consume incrementally
const bounded = yield* Stream.runCollect(Stream.iterate(0, (n) => n + 1).pipe(Stream.take(10)))
yield* Stream.runForEach(infinite, (n) => Effect.log(n))
```

### Side effects at definition time

```typescript
// WRONG: this runs once when the stream value is built, not per consumption
const stream = Stream.make(performSideEffect())

// FIX: move work into the stream
const stream2 = Stream.fromEffect(Effect.sync(performSideEffect))
// Use Stream.suspend when construction itself must be deferred
const lazy = Stream.suspend(() => buildStream())
```

### Confusing Stream and Iterable

An `Iterable` is a synchronous, in memory sequence. A `Stream` is a pull based
source that can be infinite, effectful, concurrent, and resource scoped. Reach
for `Stream` when values arrive over time or acquisition needs `Effect`, not
for plain collections.

### Bypassing combinators with promises

Do not accumulate a stream into arrays with external loops when a combinator
does it: `take`, `drop`, `groupAdjacentBy`, `grouped`, `mapAccum`, and the run
family are safe on infinite sources and preserve interruption. Reserve
`toAsyncIterable`, `toReadableStream`, and `toQueue` for boundaries where
Effect is not driving the loop.

## Quick reference table

| API | Import | Purpose |
| ----- | -------- | --------- |
| `Stream.make(...)` | `Stream` | Fixed values |
| `Stream.fromIterable(iter, opts?)` | `Stream` | Any Iterable with chunk size |
| `Stream.fromEffect(effect)` | `Stream` | One value, then end |
| `Stream.unfold(s, f)` | `Stream` | Effectful state machine source |
| `Stream.iterate(v, next)` | `Stream` | Infinite pure iteration |
| `Stream.paginate(s, f)` | `Stream` | Page by page source |
| `Stream.fromSchedule(s)` | `Stream` | Schedule outputs |
| `Stream.fromQueue(q)` | `Stream` | Drain a queue |
| `Stream.fromPubSub(ps)` | `Stream` | Consume a PubSub |
| `Stream.fromAsyncIterable(it, onError)` | `Stream` | Async source with error mapping |
| `Stream.runCollect` | `Stream` | Collect as `Effect<Array<A>>` |
| `Stream.runDrain` | `Stream` | Consume and discard |
| `Stream.runForEach` | `Stream` | Effect per element |
| `Stream.runFold` | `Stream` | Fold to one value |
| `Stream.runHead` | `Stream` | First element as `Option` |
| `Stream.map(f)` | `Stream` | Transform with index |
| `Stream.mapEffect(f, opts?)` | `Stream` | Effectful transform, concurrency option |
| `Stream.filter` / `filterEffect` | `Stream` | Keep matching elements |
| `Stream.flatMap(f, opts?)` | `Stream` | Flatten with concurrency option |
| `Stream.take` / `drop` | `Stream` | Slice safely on infinite sources |
| `Stream.takeUntil(f)` | `Stream` | Take through the match |
| `Stream.groupAdjacentBy(keyOf)` | `Stream` | Group consecutive equal keys |
| `Stream.grouped(n)` | `Stream` | Fixed size batches |
| `Stream.mapAccum(() => s, f)` | `Stream` | Stateful transform, thunked initial state |
| `Stream.chunks` / `rechunk(n)` | `Stream` | Work at batch level |
| `Stream.merge(self, that, opts?)` | `Stream` | Interleave with haltStrategy |
| `Stream.mergeAll(streams, opts)` | `Stream` | Merge many with concurrency |
| `Stream.zip(self, that)` | `Stream` | Pointwise pairs |
| `Stream.zipLatest(self, that)` | `Stream` | Latest of both sides |
| `Stream.combine(self, that, s, f)` | `Stream` | Custom pull combination |
| `Stream.buffer(opts)` | `Stream` | Bounded or unbounded buffer |
| `Stream.broadcast(opts)` | `Stream` | Fan out, scoped |
| `Stream.share(opts)` | `Stream` | Shared source, many consumers |
| `Stream.debounce(d)` | `Stream` | Emit after quiet period |
| `Stream.throttle(opts)` | `Stream` | Cost based rate limit |
| `Stream.switchMap(f)` | `Stream` | Cancel previous child |
| `Stream.run(self, sink)` | `Stream`, `Sink` | Consume with a sink |
| `Sink.collect` | `Sink` | Collect all input |
| `Sink.fold(() => s, cont, f)` | `Sink` | Fold with an effect, thunked initial state |
| `Sink.forEach(f)` | `Sink` | Effect per element |
| `Stream.repeat(schedule)` | `Stream` | Re-run the stream per schedule |
| `Stream.forever` | `Stream` | Re-run the stream endlessly |
| `Stream.retry(policy)` | `Stream` | Retry failures on a Schedule |
| `Stream.timeout(d)` | `Stream` | End the stream after silence |
| `Stream.timeoutOrElse(opts)` | `Stream` | Switch to a fallback stream |
| `Stream.decodeText(opts?)` | `Stream` | Uint8Array to string |
| `Stream.encodeText` | `Stream` | String to Uint8Array |
| `Stream.scoped(self)` | `Stream` | Absorb Scope into the stream |
| `Stream.ensuring(finalizer)` | `Stream` | Finalizer after any exit |
| `Stream.unwrap(effect)` | `Stream` | Effect returning a stream |
| `Stream.toQueue(opts)` | `Stream` | Scoped bridge to a queue |
| `Stream.toPubSub(opts)` | `Stream` | Scoped bridge to a PubSub |
| `Stream.toPull` | `Stream` | Scoped low level pulls |
| `Stream.catchTag` / `catchTags` | `Stream` | Tagged error recovery |
| `Stream.onError(cleanup)` | `Stream` | Cleanup effect on failure |
| `Stream.toAsyncIterable` | `Stream` | Consume without Effect |
