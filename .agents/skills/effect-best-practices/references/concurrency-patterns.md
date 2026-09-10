# Concurrency Patterns

> **Effect v4.** The `fork*` family, `Semaphore`, `Fiber`, and `Deferred` follow the rules below.
> Always call `Fiber.join(fiber)` and `Deferred.await(d)` rather than yielding the value itself.

## Fork & Fiber Patterns

**Use `Effect.forkChild`** to run effects in the background as fibers. Fibers are lightweight, cooperative threads managed by Effect's runtime.

### Basic Fork

```typescript
import { Effect, Fiber } from "effect"

const program = Effect.gen(function* () {
    // Fork a background task. Does NOT block
    const fiber = yield* Effect.forkChild(backgroundWork)

    // Do other work while background runs
    const mainResult = yield* doMainWork()

    // Wait for background result when needed
    const bgResult = yield* Fiber.join(fiber)

    return { mainResult, bgResult }
})
```

A `Fiber` is a handle, not an `Effect`. Join it with `Fiber.join` to get its result as an `Effect`.

### Fork Variants

| Variant | Lifetime | Use Case |
| --------- | ---------- | ---------- |
| `Effect.forkChild` | Parent fiber | Default, interrupted when the parent ends |
| `Effect.forkDetach` | Application lifetime | Long-running background tasks (health checks, watchers) |
| `Effect.forkScoped` | Enclosing `Scope` | Fiber interrupted when scope closes |
| `Effect.forkIn` | A specific `Scope` | Fiber tied to a scope you choose |

To run many background tasks, fork individually with `forkChild`, or use `Effect.all` or
`Effect.forEach` with a `concurrency` option. For error handling on a forked fiber, observe it
with `Fiber.join` or `Fiber.await`.

```typescript
// Detached fiber, lives until app exits
const healthCheck = Effect.gen(function* () {
    yield* Effect.forkDetach(
        Effect.repeat(
            checkHealth,
            Schedule.spaced("30 seconds"),
        ),
    )
})

// Scoped fiber, cleaned up when scope closes
const scopedWorker = Effect.scoped(
    Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(longRunningTask)
        yield* doWork()
        // fiber automatically interrupted here
    }),
)
```

### Fork Options

All four variants accept an options object:

```typescript
const fiber = yield* Effect.forkChild(task, {
    startImmediately: true,      // run now rather than deferring to the scheduler
    uninterruptible: "inherit",  // true | "inherit" | undefined
})
```

- **`startImmediately`.** When `true`, the fiber begins executing immediately instead of being
  deferred. This is helpful when the fork must observe state before the parent mutates it.
- **`uninterruptible`.** `true` makes the fiber uninterruptible, `"inherit"` takes the parent's
  interruptibility, `undefined` applies the default.

### Fiber Operations

```typescript
// Join, wait for result (re-raises errors)
const result = yield* Fiber.join(fiber)

// Await, get Exit (success or failure) without re-raising
const exit = yield* Fiber.await(fiber)

// Interrupt, gracefully stop a fiber (runs finalizers)
yield* Fiber.interrupt(fiber)
```

> See also: [Fork + Immediate Join] in `anti-patterns.md` for why `Effect.forkChild` plus immediate `Fiber.join` adds no value

## Parallel Execution

### Effect.all with Concurrency

**Use `Effect.all` with `{ concurrency }` option** for parallel execution of multiple effects:

```typescript
// Run all tasks in parallel (unbounded)
const results = yield* Effect.all(tasks, { concurrency: "unbounded" })

// Limit to 5 concurrent tasks
const results = yield* Effect.all(tasks, { concurrency: 5 })

// Sequential (default), no concurrency option
const results = yield* Effect.all(tasks)
```

### Effect.forEach with Concurrency

```typescript
// Process items in parallel with bounded concurrency
const processed = yield* Effect.forEach(
    users,
    (user) => sendNotification(user),
    { concurrency: 10 },
)
```

### Short-Circuiting

By default, parallel operations short-circuit on first failure. Use `{ mode: "result" }` to run
everything and collect each outcome:

```typescript
// Collect all successes and failures as Results
const results = yield* Effect.all(tasks, {
    concurrency: "unbounded",
    mode: "result",
})
```

Run with `mode: "result"`, then keep the `Result.Success` values.

## Queue

Queues provide point-to-point communication between fibers with backpressure.

### Queue Variants

| Variant | Behavior When Full |
| --------- | ------------------- |
| `Queue.bounded(n)` | Suspends producer until space available (backpressure) |
| `Queue.unbounded()` | Never blocks, grows without limit |
| `Queue.sliding(n)` | Drops oldest items when full |
| `Queue.dropping(n)` | Drops newest items when full |

### Producer/Consumer Pattern

```typescript
import { Effect, Fiber, Queue } from "effect"

const program = Effect.gen(function* () {
    const queue = yield* Queue.bounded<Job>(100)

    // Producer fiber
    const producer = yield* Effect.forkChild(
        Effect.forEach(
            jobs,
            (job) => Queue.offer(queue, job),
            { discard: true },
        ),
    )

    // Consumer fiber
    const consumer = yield* Effect.forkChild(
        Effect.forever(
            Effect.gen(function* () {
                const job = yield* Queue.take(queue)
                yield* processJob(job)
            }),
        ),
    )

    // Wait for producer to finish
    yield* Fiber.join(producer)

    // Signal consumer to stop
    yield* Queue.shutdown(queue)
    yield* Fiber.join(consumer)
})
```

### Queue Operations

```typescript
// Add item (suspends if bounded queue is full)
yield* Queue.offer(queue, item)

// Add multiple items
yield* Queue.offerAll(queue, items)

// Take item (suspends if empty)
const item = yield* Queue.take(queue)

// Take all available items (non-blocking)
const items = yield* Queue.takeAll(queue)

// Take one without blocking, returns Option
const maybe = yield* Queue.poll(queue)

// Check size
const size = yield* Queue.size(queue)

// Signal graceful completion (Cause.Done) to consumers
yield* Queue.end(queue)

// Shutdown, interrupts all waiting fibers
yield* Queue.shutdown(queue)
```

Call `Queue.poll` repeatedly up to the limit when a bounded non-blocking take is needed, or
`Queue.clear` when draining everything is acceptable. `Queue.end` signals graceful completion
through the `Cause.Done` signal.

## PubSub

PubSub provides broadcast communication. Every subscriber receives every message.

```typescript
import { Effect, PubSub } from "effect"

const program = Effect.gen(function* () {
    const pubsub = yield* PubSub.bounded<Event>(256)

    // Subscribe returns a scoped Subscription, requires a Scope
    const sub1 = yield* PubSub.subscribe(pubsub)
    const sub2 = yield* PubSub.subscribe(pubsub)

    // Publish, delivered to ALL subscribers
    yield* PubSub.publish(pubsub, { type: "user_created", userId: "123" })

    // Each subscriber receives the message independently
    const event1 = yield* PubSub.take(sub1)
    const event2 = yield* PubSub.take(sub2)
    // event1 === event2
}).pipe(Effect.scoped)
```

`PubSub.subscribe` returns a `Subscription`, not a `Queue`. Read it with `PubSub.take` or
`PubSub.takeAll`. The subscription is scoped, so the program needs a `Scope`.

### PubSub Variants

| Variant | Behavior When Full |
| --------- | ------------------- |
| `PubSub.bounded(n)` | Suspends publisher until subscribers catch up |
| `PubSub.unbounded()` | Never blocks publisher |
| `PubSub.sliding(n)` | Drops oldest messages per subscriber |
| `PubSub.dropping(n)` | Drops newest messages per subscriber |

## Semaphore

**Use `Semaphore.make`** to limit concurrent access to a shared resource:

```typescript
import { Effect, Semaphore } from "effect"

const program = Effect.gen(function* () {
    // Allow max 3 concurrent database connections
    const semaphore = yield* Semaphore.make(3)

    const queryWithLimit = (sql: string) =>
        semaphore.withPermits(1)(
            executeQuery(sql),
        )

    // Only 3 queries run at a time, others wait
    yield* Effect.all(
        queries.map((q) => queryWithLimit(q)),
        { concurrency: "unbounded" },
    )
})
```

### Multiple Permits

```typescript
// Heavy operation requires 2 permits
const heavyQuery = semaphore.withPermits(2)(expensiveOperation)

// Non-blocking variant, skips when no permit is free
const opportunistic = semaphore.withPermitsIfAvailable(1)(optionalWork)
```

For per-key limiting (for example one permit per tenant), use `PartitionedSemaphore`.

## Deferred & Latch

### Deferred, One-Time Signal

`Deferred` is a one-shot value that can be set exactly once. Multiple fibers can wait for it.

```typescript
import { Deferred, Effect, Fiber } from "effect"

const program = Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()

    // Worker waits until signaled
    const worker = yield* Effect.forkChild(
        Effect.gen(function* () {
            yield* Deferred.await(ready)
            yield* doWork()
        }),
    )

    // Initialize, then signal readiness
    yield* initialize()
    yield* Deferred.succeed(ready, undefined)

    yield* Fiber.join(worker)
})
```

**`Deferred` is not an `Effect`.** Always call `Deferred.await(deferred)` explicitly to wait
for the value.

### Deferred Operations

```typescript
// Create
const deferred = yield* Deferred.make<string>()

// Complete with success, unblocks all waiters
yield* Deferred.succeed(deferred, "done")

// Complete with failure, all waiters receive error
yield* Deferred.fail(deferred, new MyError())

// Wait for completion
const value = yield* Deferred.await(deferred)
```

### Latch, Open/Close Gate

`Latch` is a gate that starts closed and can be opened to release all waiters:

```typescript
import { Effect, Fiber, Latch } from "effect"

const program = Effect.gen(function* () {
    const gate = yield* Latch.make()

    // Workers wait at the gate
    const workers = yield* Effect.all(
        Array.from({ length: 5 }, () =>
            Effect.forkChild(
                Effect.gen(function* () {
                    yield* gate.await
                    yield* processItem()
                }),
            ),
        ),
    )

    // Open the gate, all workers start simultaneously
    yield* Latch.open(gate)

    yield* Effect.all(workers.map(Fiber.join))
})
```

`await` is a property on the latch (`gate.await`), while `open`, `close`, and `release` are
available both as methods and as module functions. `Latch.whenOpen(effect)` runs an effect only
once the gate is open.

## Shared State with Ref

**Always use `Ref` for mutable state** shared across fibers. Never use `let` variables mutated inside Effects.

> See also: [Mutable State Without Ref] in `anti-patterns.md`

```typescript
import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
    const counter = yield* Ref.make(0)

    // Safe concurrent updates, no race conditions
    yield* Effect.all(
        Array.from({ length: 1000 }, () =>
            Ref.update(counter, (n) => n + 1),
        ),
        { concurrency: "unbounded" },
    )

    const final = yield* Ref.get(counter)
    // final === 1000 (guaranteed)
})
```

### Ref Operations

```typescript
// Create
const ref = yield* Ref.make(initialValue)

// Read, Ref.get is mandatory
const value = yield* Ref.get(ref)

// Set a new value
yield* Ref.set(ref, newValue)

// Atomic read-modify-write
yield* Ref.update(ref, (current) => current + 1)

// Atomic modify and return old value
const old = yield* Ref.getAndUpdate(ref, (n) => n + 1)

// Atomic modify and return computed value
const result = yield* Ref.modify(ref, (current) => [
    computeResult(current), // returned value
    newState(current),      // new state
])
```

`Ref` is a handle, not an `Effect`. Yielding it directly is a type error.

## Race & Timeout

### Effect.race

Run two effects concurrently, return the first to complete, interrupt the loser:

```typescript
// Use fastest available source
const data = yield* Effect.race(
    fetchFromCache(key),
    fetchFromDatabase(key),
)
```

### Effect.timeout

```typescript
import { Duration, Effect } from "effect"

// Fails with TimeoutError if the duration elapses
const result = yield* longOperation.pipe(
    Effect.timeout(Duration.seconds(5)),
)

// Fail with a specific error on timeout
const result = yield* longOperation.pipe(
    Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        onTimeout: () => Effect.fail(new OperationTimedOut({ message: "Operation timed out" })),
    }),
)
```

`Effect.timeoutOrElse` takes a fallback `Effect`, so wrap a custom error in `Effect.fail`.
The built-in timeout failure is `TimeoutError`.

> See also: [Manual Retry/Timeout Logic] in `anti-patterns.md`

## Graceful Shutdown

### NodeRuntime.runMain

**Use `NodeRuntime.runMain`** as the entry point for Node.js applications:

```typescript
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

const program = Effect.gen(function* () {
    yield* startServer()
    yield* Effect.log("Server running")
    // Keeps running until interrupted (SIGINT/SIGTERM)
    yield* Effect.never
})

NodeRuntime.runMain(program.pipe(Effect.scoped))
```

Keep-alive is built into the core runtime. A fiber suspended on `Deferred.await` holds the
process open. `runMain` remains the recommended entry point for signal handling (SIGINT and
SIGTERM interrupt the root fiber), exit codes, and error reporting.

### Effect.addFinalizer

Register cleanup logic that runs when the enclosing scope closes:

```typescript
const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
        Effect.log("Shutting down gracefully..."),
    )

    const server = yield* startServer()

    yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
            yield* server.close()
            yield* Effect.log("Server stopped")
        }),
    )

    yield* Effect.never
})
```

> See also: [Cleanup Guarantees] in `resource-patterns.md` for how finalizers interact with resources

## Polling

**Use `Effect.repeat` with `Schedule`** for polling patterns:

```typescript
import { Duration, Effect, Schedule } from "effect"

// Poll every 5 seconds
const pollStatus = Effect.repeat(
    checkStatus,
    Schedule.spaced(Duration.seconds(5)),
)

// Exponential backoff, capped at 30s. min and max take one array argument
const pollWithBackoff = Effect.repeat(
    checkStatus,
    Schedule.min([
        Schedule.exponential(Duration.seconds(1)),
        Schedule.spaced(Duration.seconds(30)),
    ]),
)

// Poll until condition met
const waitForReady = Effect.repeat(
    checkStatus,
    Schedule.spaced(Duration.seconds(1)).pipe(
        Schedule.while((meta) => meta.output !== "ready"),
    ),
)

// Fixed interval (includes execution time in interval)
const fixedPoll = Effect.repeat(
    checkStatus,
    Schedule.fixed(Duration.seconds(10)),
)
```

`Schedule.while` receives a metadata object. Read `meta.input` for the effect value or
`meta.output` for the schedule output.

```typescript
// Continue while the effect value satisfies a predicate, using meta.input
const repeatWhileInput = Effect.repeat(
    fetchStatus,
    Schedule.spaced(Duration.seconds(1)).pipe(
        Schedule.while((meta) => meta.input !== "done"),
    ),
)

// Continue while the schedule output satisfies a predicate, using meta.output
const repeatWhileOutput = Effect.repeat(
    checkStatus,
    Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.while((meta) => meta.output < Duration.seconds(30)),
        Schedule.upTo({ times: 10 }),
    ),
)
```

### Schedule Comparison

| Schedule | Behavior |
| ---------- | ---------- |
| `Schedule.spaced(d)` | Wait `d` between end of one execution and start of next |
| `Schedule.fixed(d)` | Run at fixed intervals (accounts for execution time) |
| `Schedule.exponential(d)` | Double the delay each time: `d`, `2d`, `4d`, `8d`... |
| `Schedule.recurs(n)` | Repeat at most `n` times |
| `Schedule.min([a, b])` | Fastest-delay composition, one array argument |
| `Schedule.max([a, b])` | Slowest-delay composition, one array argument |
| `Schedule.while(f)` | Continue while predicate over `meta.input` and `meta.output` holds |

## Quick Reference Table

| Primitive | Import | Create | Use Case |
| ----------- | -------- | -------- | ---------- |
| `Effect.forkChild` | `Effect` | `Effect.forkChild(effect, opts?)` | Background task tied to parent |
| `Effect.forkDetach` | `Effect` | `Effect.forkDetach(effect, opts?)` | App-lifetime background task |
| `Effect.forkScoped` | `Effect` | `Effect.forkScoped(effect, opts?)` | Scope-lifetime background task |
| `Fiber.join` | `Fiber` | `Fiber.join(fiber)` | Wait for fiber result |
| `Fiber.interrupt` | `Fiber` | `Fiber.interrupt(fiber)` | Stop fiber gracefully |
| `Effect.all` | `Effect` | `Effect.all(effects, { concurrency })` | Parallel execution |
| `Effect.forEach` | `Effect` | `Effect.forEach(items, fn, { concurrency })` | Parallel iteration |
| `Queue.bounded` | `Queue` | `Queue.bounded<A>(n)` | Point-to-point with backpressure |
| `Queue.unbounded` | `Queue` | `Queue.unbounded<A>()` | Point-to-point, no limit |
| `Queue.sliding` | `Queue` | `Queue.sliding<A>(n)` | Drop oldest when full |
| `Queue.dropping` | `Queue` | `Queue.dropping<A>(n)` | Drop newest when full |
| `PubSub.bounded` | `PubSub` | `PubSub.bounded<A>(n)` | Broadcast with backpressure |
| `Semaphore.make` | `Semaphore` | `Semaphore.make(n)` | Limit concurrent access |
| `PartitionedSemaphore` | `PartitionedSemaphore` | n/a | Per-key concurrency limiting |
| `Deferred.make` | `Deferred` | `Deferred.make<A>()` | One-time signal |
| `Latch.make` | `Latch` | `Latch.make()` | Open/close gate |
| `Ref.make` | `Ref` | `Ref.make(initial)` | Atomic shared state |
| `Effect.race` | `Effect` | `Effect.race(a, b)` | First to complete wins |
| `Effect.timeout` | `Effect` | `Effect.timeout(d)` | Fail with `TimeoutError` |
| `Effect.timeoutOrElse` | `Effect` | `Effect.timeoutOrElse({ duration, onTimeout })` | Timeout with fallback Effect |
| `Effect.repeat` | `Effect` | `Effect.repeat(effect, schedule)` | Polling, repeated execution |
