# Transactional State Patterns

> **Effect v4.** Transactional state lives in the `Tx` modules: `TxRef`, `TxHashMap`, `TxHashSet`,
> `TxQueue`, `TxPubSub`, `TxSemaphore`, `TxDeferred`, `TxSubscriptionRef`, `TxChunk`,
> `TxPriorityQueue`, and `TxReentrantLock`. A transaction is a block started with `Effect.tx`
> that records reads and writes to `Tx*` state in a journal and commits them together only
> when the whole block succeeds. Transactions are composable: nested `Effect.tx` calls join the
> outermost transaction instead of creating a new one. They are optimistic: if another
> transaction changes a value you read before you commit, your body is discarded and re-run.

## Transactions with Effect.tx

The entry point is `Effect.tx`. Its signature is:

```typescript
Effect.tx<A, E, R>(effect: Effect<A, E, R>): Effect<A, E, Exclude<R, Transaction>>
```

The body can be any `Effect`, with any error type `E` and any requirements `R`. The only
requirement `Effect.tx` removes from the `R` channel is `Transaction`, the internal service
that carries the journal. There is no separate runtime flag to enable.

`TxRef` is the base building block. Create one with `TxRef.make`, which returns an `Effect`;
`TxRef.makeUnsafe` constructs one synchronously outside an `Effect` workflow. Read and write
inside a transaction with `TxRef.get`, `TxRef.set`, `TxRef.update`, and `TxRef.modify`, where
`modify` takes a function returning `[returnValue, newValue]`:

```typescript
import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
    const ref = yield* TxRef.make(0)

    yield* Effect.tx(Effect.gen(function* () {
        const current = yield* TxRef.get(ref)
        yield* TxRef.set(ref, current + 1)
    }))

    return yield* TxRef.get(ref)
    // => 1
})
```

### Atomicity and retry on conflict

`Effect.tx` runs the body in a loop. Each `TxRef` touched in the body is recorded in the
journal together with the version observed at first access. At commit time every journaled
version is checked against the live value:

- All versions still match: the journaled writes are committed and the versions bump.
- Any version changed (another transaction committed first): the journal is discarded and the
  body re-runs from the start.

Reads participate in conflict detection too. `TxRef.get` is implemented as a modify, so a
transaction that only reads a `TxRef` still tracks it and retries if it changes. Because every
accessed `TxRef` is journaled, invariants that span several variables hold at commit time:

```typescript
import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
    const balance = yield* TxRef.make(100)
    const ledger = yield* TxRef.make<Array<string>>([])

    // Balance and ledger always move together, or not at all
    yield* Effect.tx(Effect.gen(function* () {
        const current = yield* TxRef.get(balance)
        if (current < 30) return yield* Effect.fail(new Error("insufficient funds"))
        yield* TxRef.set(balance, current - 30)
        yield* TxRef.update(ledger, (entries) => [...entries, "-30"])
    }))
})
```

Two transactions that touch the same `TxRef` cannot interleave: the loser detects the version
change and re-runs. Transactions on disjoint `TxRef` values commit independently. Every
`TxRef` operation wraps itself in `Effect.tx` internally, so a standalone
`yield* TxRef.set(ref, value)` commits immediately as a one-operation transaction; the
explicit `Effect.tx` block is what makes several operations atomic together.

## Transactions vs Ref

| Concern | `Ref` | `TxRef` + `Effect.tx` |
|---------|-------|----------------------|
| Single value update | `Ref.update` | single `TxRef` op, or one-op transaction |
| Invariant across several values | not expressible, updates race | commit is all or nothing |
| Conflict behavior | last writer wins per operation | body re-runs on conflict |
| Waiting for a condition | build with `Deferred` or polling | `Effect.txRetry` suspends until state changes |
| Blocking data structures | `Queue`, `PubSub`, `Semaphore` | `TxQueue`, `TxPubSub`, `TxSemaphore` |

Use `Ref` when each update is independent. Use `TxRef` when two or more values must change
together, or when an update must observe state and react, such as conditionally failing or
waiting. `Ref.update` is atomic per call, but two consecutive `Ref.update` calls are not a
unit: a concurrent fiber can read between them. `Effect.tx` closes that gap.

> See also: [Shared State with Ref] in `concurrency-patterns.md`

## Effect.txRetry and Blocking Operations

`Effect.txRetry` marks the current transaction for retry. The body stops, the transaction
suspends until one of the `TxRef` values it accessed is committed by another transaction, and
then the body re-runs from the start with a fresh journal:

```typescript
import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
    const ref = yield* TxRef.make(0)
    yield* Effect.forkChild(Effect.tx(TxRef.set(ref, 1)))

    return yield* Effect.tx(Effect.gen(function* () {
        const value = yield* TxRef.get(ref)
        // Suspend until another transaction commits to ref, then re-run
        return value === 0 ? yield* Effect.txRetry : value
    }))
    // => 1
})
```

This is the mechanism behind all blocking `Tx` operations: `TxQueue.take` on an empty queue,
`TxSemaphore.acquire` with no free permit, and `TxPriorityQueue.take` on an empty queue all
call `Effect.txRetry` internally and are woken by the committing transaction. Retry is not a
busy spin. There is no retry guard: a transaction whose exit condition is never written waits
forever, so keep the producing side in view, as with `Queue` backpressure.

## Tx Data Structures

All of the following store their state in one or more `TxRef` values, so they inherit the
same journal, conflict, and commit behavior.

### TxHashMap and TxHashSet

`TxHashMap` is a transactional map backed by a `TxRef` holding an immutable `HashMap`.
Constructors: `empty`, `make(...entries)`, `fromIterable(entries)`. Reads return `Option`:

```typescript
import { Effect, Option, TxHashMap } from "effect"

const program = Effect.gen(function* () {
    const balances = yield* TxHashMap.make(["alice", 100], ["bob", 50])

    yield* Effect.tx(Effect.gen(function* () {
        const alice = yield* TxHashMap.get(balances, "alice")
        yield* TxHashMap.set(balances, "alice", Option.getOrElse(alice, () => 0) - 30)
        yield* TxHashMap.remove(balances, "bob")
    }))

    return yield* TxHashMap.get(balances, "alice")
    // => Option.some(70)
})
```

Also: `has`, `clear`, `size`, `modify`, `modifyAt`, `keys`, `values`, `entries`, `snapshot`,
`union`, `removeMany`, `setMany`, `map`, `filter`, `reduce`, `filterMap`, `hasBy`, `findFirst`,
`getHash`, `hasHash`. `keys`, `values`, and `entries` return arrays from the current view.

`TxHashSet` is a transactional set backed by a `TxRef` of a `HashSet`. Constructors: `empty`,
`make(...values)`, `fromIterable`, `fromHashSet`. Add and remove with `add` and `remove`,
query with `has`, `size`, `isEmpty`, read out an immutable `HashSet` with `toHashSet`. Set
algebra is transactional: `union`, `intersection`, `difference`, `isSubset`, plus `some`,
`every`, `map`, `filter`, `reduce`.

### TxQueue

A transactional queue with the same bounded, unbounded, dropping, and sliding variants as
`Queue`. `TxQueue.take` suspends through `Effect.txRetry` when the queue is empty, so a
consumer written with `Effect.tx` waits transactionally and re-runs when a producer commits:

```typescript
import { Effect, TxQueue } from "effect"

const program = Effect.gen(function* () {
    const queue = yield* TxQueue.bounded<number>(10)

    yield* Effect.forkChild(Effect.tx(TxQueue.offer(queue, 42)))

    // take inside a transaction: suspends while empty, re-runs when an offer commits
    return yield* Effect.tx(TxQueue.take(queue))
    // => 42
})
```

The type is split into `TxEnqueue` (producer side), `TxDequeue` (consumer side), and `TxQueue`
(both), so a service can expose only the end it should. Consumers see the error channel `E`:
a queue failed with `TxQueue.fail` or `failCause` re-raises that error or cause to `take`.
`TxQueue.end` sends the graceful `Cause.Done` signal, `shutdown` terminates waiters, and
`poll` returns `Option` instead of suspending. Also: `offerAll`, `takeAll`, `takeN`,
`takeBetween`, `peek`, `size`, `isEmpty`, `isFull`, `clear`, `isOpen`, `interrupt`.

### TxPubSub

A transactional broadcast hub. Every subscriber receives every published message.
Subscriptions are scoped and produce a `TxQueue`:

```typescript
import { Effect, TxPubSub, TxQueue } from "effect"

const program = Effect.gen(function* () {
    const hub = yield* TxPubSub.unbounded<string>()

    return yield* Effect.scoped(Effect.gen(function* () {
        const sub1 = yield* TxPubSub.subscribe(hub)
        const sub2 = yield* TxPubSub.subscribe(hub)

        yield* Effect.tx(TxPubSub.publish(hub, "broadcast"))

        return [yield* TxQueue.take(sub1), yield* TxQueue.take(sub2)]
        // => ["broadcast", "broadcast"]
    }))
})
```

`subscribe` returns `Effect<TxQueue<A>, never, Scope>`; read the subscription with `TxQueue`
operations. Variants: `bounded(capacity)`, `dropping(capacity)`, `sliding(capacity)`,
`unbounded()`. Also `publishAll`, `size`, `capacity` (a plain function, not an `Effect`),
`awaitShutdown`, `shutdown`, `isShutdown`. `acquireSubscriber` and `releaseSubscriber` expose
the acquire and release steps so subscription registration can be composed with other
operations in a single transaction, which is how `TxSubscriptionRef.changes` is built.

### TxSemaphore

A transactional counting semaphore. `acquire` suspends through `Effect.txRetry` when no permit
is free, and `acquireN(n)` takes several at once, dying with a defect for `n <= 0`;
requesting more than the fixed capacity can wait forever. Non-blocking attempts:
`tryAcquire`, `tryAcquireN`. Automatic release: `withPermit`, `withPermits`, and the scoped
`withPermitScoped`. Release with `release` and `releaseN`. `available` and `capacity` report
state:

```typescript
import { Effect, TxSemaphore } from "effect"

const program = Effect.gen(function* () {
    const permits = yield* TxSemaphore.make(2)

    yield* TxSemaphore.acquire(permits)
    yield* TxSemaphore.acquire(permits)

    return yield* TxSemaphore.available(permits)
    // => 0
})
```

### TxDeferred and TxSubscriptionRef

**`TxDeferred`** is a transactional one-shot cell of a `Result`, completed with `succeed`,
`fail`, or `done`. It does not have an `await` combinator. `poll` reads the current outcome as
`Option<Result<A, E>>` inside a transaction, so consumers decide how to wait.

**`TxSubscriptionRef`** is a transactional value plus a change subscription. Value operations
mirror `Ref`: `get`, `set`, `update`, `modify`, `getAndSet`, `getAndUpdate`, `updateAndGet`.
`changes` returns a scoped `TxQueue` seeded with the current value, and `changesStream`
returns a `Stream` of the current value followed by every committed update. The publish step
happens in the transaction, so a change and a related `TxRef` write become visible atomically.
After `set(ref, 1)` then `set(ref, 2)`, the first `changesStream` element is `2`.

### TxChunk, TxPriorityQueue, TxReentrantLock

**`TxChunk`** is a transactional sequence backed by a `TxRef` of a `Chunk`; `TxQueue` uses it
for its items. Fit for growing or slicing a list atomically: `make`, `empty`, `fromIterable`,
`get`, `set`, `update`, `modify`, `append`, `prepend`, `appendAll`, `prependAll`, `concat`,
`take`, `drop`, `slice`, `size`, `map`, `filter`.

**`TxPriorityQueue`** is a transactional priority queue ordered by an `Order`, built with
`empty(order)`, `make(order)(...elements)`, or `fromIterable`. `take` and `takeOption`
suspend or return `Option.none` when empty via `Effect.txRetry`. Also `peek`, `peekOption`,
`offer`, `offerAll`, `takeAll`, `takeUpTo`, `removeIf`, `retainIf`, `toArray`, `size`.

**`TxReentrantLock`** is a transactional reader writer lock. Many readers or one writer, and
a holder can acquire again without deadlocking. Acquire and release with `acquireRead`,
`acquireWrite`, `releaseRead`, `releaseWrite`, all transactional and suspending via
`Effect.txRetry` while the lock is held incompatibly. Scoped wrappers: `readLock`,
`writeLock`. Callback wrappers: `withReadLock`, `withWriteLock`, `withLock`, such as
`TxReentrantLock.withWriteLock(lock, effect)`. State queries: `locked`, `readLocked`,
`writeLocked`, `readLocks`, `writeLocks`.

## Composing Transactions

Nested `Effect.tx` calls do not create nested boundaries. An inner `Effect.tx` detects the
active `Transaction` service, reuses its journal and retry state, and returns. The outermost
call creates the boundary, runs the retry loop, and commits or rolls back everything:

```typescript
import { Effect, TxRef } from "effect"

const transfer = (from: TxRef.TxRef<number>, to: TxRef.TxRef<number>, amount: number) =>
    Effect.tx(Effect.gen(function* () {
        yield* TxRef.update(from, (n) => n - amount)
        yield* TxRef.update(to, (n) => n + amount)
    }))

const program = Effect.gen(function* () {
    const a = yield* TxRef.make(100)
    const b = yield* TxRef.make(0)

    // Both transfers commit as one unit
    yield* Effect.tx(Effect.gen(function* () {
        yield* transfer(a, b, 40)
        yield* transfer(b, a, 40)
    }))

    return [yield* TxRef.get(a), yield* TxRef.get(b)]
    // => [100, 0]
})
```

This makes `Effect.tx` suitable inside service methods: a helper that calls `Effect.tx`
composes correctly whether it runs alone or inside a larger transaction. There is no `orElse`,
`race`, or timeout combinator for transactions. Retry is driven only by version conflicts and
`Effect.txRetry`. For a bounded wait, wrap the whole `Effect.tx` call in `Effect.timeout`,
which treats the transaction like any other effect from the outside.

## Errors and Interruption

Verified from the implementation of `Effect.tx`:

- **Failure.** The journal is cleared and nothing commits. The error passes through the `E`
  channel unchanged.
- **Interruption.** The body runs interruptible; interrupting it mid transaction clears the
  journal and commits nothing. The retry loop itself runs uninterruptibly.
- **Retry exhaustion.** There is none. A transaction re-runs until it commits, fails, or is
  interrupted. Guard against starvation as you would for `Queue` contention.
- **Re-execution.** On any retry the body runs again from the start. Side effects performed
  directly in the body repeat, so keep the body limited to journal operations plus pure
  computation and move irreversible work to after the transaction commits.
- **Failure before retry.** When the body fails after calling `Effect.txRetry`, the
  transaction first waits for pending commits on the refs it journaled, then re-runs. This is
  how suspension works internally, and why a failure inside a blocking loop does not spin.

Because `Effect.tx` accepts arbitrary `R` and `E`, nothing in the type system stops you from
putting asynchronous IO in the body. The type parameters show the effect flows through
unchanged apart from `Transaction`, so the guarantee you get is commit atomicity, not
idempotence of the body.

## Testing

Transactions commit and retry through synchronous journal operations and fiber dispatcher
tasks, not through `Clock`. TestClock does not gate commits or retry resumption, so you do
not need to advance time to make a transaction proceed. The `import.meta.vitest` examples in
the `Tx` module sources run with plain `Effect.runPromise`, and the same style works in
`@effect/vitest`. To test conflict retry, fork one transaction that mutates a ref and assert
that a reading transaction re-runs and observes the committed value, as in the `Effect.txRetry`
example.

> See also: `testing-patterns.md` for test wiring and `v4-semantics.md` for how `Effect`
> evaluates generator bodies.

## Anti-patterns

### Mixing Ref and TxRef for the same invariant

The `Ref` write below is invisible to the journal. A conflicting commit retries the `TxRef`
changes but the `Ref` change has already happened, so the invariant breaks. Keep one state
model per concept, and keep the whole invariant in `Tx*` types:

```typescript
// WRONG, two storage mechanisms for one concept
const addItem = Effect.tx(Effect.gen(function* () {
    yield* TxRef.update(parts, (ps) => [...ps, 10])
    yield* Ref.update(total, (n) => n + 10) // not journaled, not retried, not atomic with parts
}))
```

### Irreversible IO inside the transaction body

Retry re-executes the whole body, so an HTTP call or log line inside it repeats:

```typescript
// WRONG, the HTTP call repeats on every retry
const charge = Effect.tx(Effect.gen(function* () {
    const balance = yield* TxRef.get(account)
    if (balance < amount) return yield* Effect.txRetry
    yield* TxRef.update(account, (n) => n - amount)
    yield* chargeCard(amount) // re-runs if another transaction touches account
}))
```

Journal the intent transactionally instead, then act on the result: move `chargeCard` after
the `Effect.tx` block and have the block return whether the debit went through.

### Reaching into journal state by hand

`Effect.Transaction` is a real `Context.Service` with `retry` and `journal` fields, and the
module docs show it can be provided by hand. Treat that as an implementation detail.
Application code should read and write `Tx*` values only through the module combinators, which
keep the version bookkeeping correct.

### Long-running bodies that hold stale reads

The longer a transaction runs, the more likely a concurrent commit invalidates it and the
body re-runs from the top. Keep transactions short, read only the refs the decision needs,
and push slow work outside the boundary.

## Quick Reference

| Module | Purpose | Blocking ops |
|--------|---------|--------------|
| `TxRef` | Transactional value, the base of all others | none, use `Effect.txRetry` |
| `TxHashMap` | Transactional map over `HashMap` | none |
| `TxHashSet` | Transactional set over `HashSet` | none |
| `TxQueue` | Producer/consumer queue | `take`, `takeAll`, `takeN`, `takeBetween`, `peek` |
| `TxPubSub` | Broadcast hub | consumers block through `TxQueue.take` |
| `TxSemaphore` | Permit counting | `acquire`, `acquireN` |
| `TxDeferred` | One-shot `Result` cell | none, `poll` returns `Option` |
| `TxSubscriptionRef` | Value plus committed-change subscription | consumers block through `TxQueue.take` |
| `TxChunk` | Transactional sequence | none |
| `TxPriorityQueue` | Priority queue over `Order` | `take`, `takeAll`, `takeUpTo` |
| `TxReentrantLock` | Reentrant reader/writer lock | `acquireRead`, `acquireWrite` |
