# Resource Patterns

> **Effect v4.** `Layer.effect` handles scoped and unscoped construction. `ManagedRuntime` is a
> handle with run methods and a dispose method, not an `Effect`. `Effect.acquireRelease` and
> `Effect.scoped` manage resource lifetimes.

## Effect.acquireRelease

**Use `Effect.acquireRelease`** (the bracket pattern) to guarantee cleanup of resources. The release function runs on success, failure, AND interruption.

```typescript
import { Effect } from "effect"

const managedConnection = Effect.acquireRelease(
    // Acquire, runs once, can fail
    Effect.gen(function* () {
        const conn = yield* connectToDatabase()
        yield* Effect.log("Connection acquired")
        return conn
    }),
    // Release, guaranteed to run, receives the acquired resource and the Exit
    (conn) =>
        Effect.gen(function* () {
            yield* conn.close()
            yield* Effect.log("Connection released")
        }),
)
```

Pass `{ interruptible: true }` as a third argument for interruptible acquisition:

```typescript
const managedConnectionInterruptible = Effect.acquireRelease(
    connectToDatabase(),
    (conn) => conn.close().pipe(Effect.orDie),
    { interruptible: true },
)
```

> See also: [Manual try/finally for Resource Cleanup] in `anti-patterns.md` for why `try/finally` does not work in Effect generators

### Using the Resource

```typescript
const program = managedConnection.pipe(
    Effect.flatMap((conn) => conn.query("SELECT * FROM users")),
    Effect.scoped, // Required, triggers release when scope closes
)
```

## Effect.scoped

**`Effect.scoped` creates a scope** that manages the lifetime of all resources acquired within it. When the scope closes, all finalizers run in LIFO order.

### Inline Scoping

```typescript
// Scope wraps the entire pipeline
const result = yield* Effect.scoped(
    managedConnection.pipe(
        Effect.flatMap((conn) => conn.query(sql)),
    ),
)
```

### Scoped Generator Block

```typescript
// Scope wraps a gen block, resource available throughout
const result = yield* Effect.scoped(
    Effect.gen(function* () {
        const conn = yield* managedConnection
        const users = yield* conn.query("SELECT * FROM users")
        const orders = yield* conn.query("SELECT * FROM orders")
        return { users, orders }
    }),
)
```

### Multiple Resources in One Scope

```typescript
const program = Effect.scoped(
    Effect.gen(function* () {
        const db = yield* managedDbConnection
        const cache = yield* managedRedisConnection
        const queue = yield* managedQueueConnection

        // All three available here
        const data = yield* db.query(sql)
        yield* cache.set("key", data)
        yield* queue.publish(data)

        // On scope close: queue released, then cache, then db (LIFO)
    }),
)
```

### Providing a Scope Without Closing It

`Scope.provide` satisfies an effect `Scope` requirement without closing the scope when the
effect completes:

```typescript
import { Effect, Scope } from "effect"

const program = Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* myScopedEffect.pipe(Scope.provide(scope))
    // scope still open, close it explicitly when done
})
```

Note: in tests, `it.effect` and `it.live` already provide and close a `Scope` per test, so do not
wrap test bodies in `Effect.scoped`. See `testing-patterns.md`.

## Cleanup Guarantees

The release function in `acquireRelease` is guaranteed to run regardless of how the effect completes:

| Outcome | Release Runs? | Notes |
|---------|--------------|-------|
| Success | Yes | After the scoped effect returns |
| Failure | Yes | After the error propagates |
| Interruption | Yes | After the fiber is interrupted |

```typescript
const safeResource = Effect.acquireRelease(
    acquire,
    (resource, exit) =>
        // exit tells you HOW the scope closed
        Exit.match(exit, {
            onSuccess: () =>
                Effect.log("Releasing after success").pipe(
                    Effect.andThen(resource.close()),
                ),
            onFailure: (cause) =>
                Effect.log("Releasing after failure", { cause: String(cause) }).pipe(
                    Effect.andThen(resource.close()),
                ),
        }),
)
```

### Effect.addFinalizer

Register cleanup logic directly within a scoped block:

```typescript
const program = Effect.scoped(
    Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
            Effect.log("Scope closing, cleaning up"),
        )

        const conn = yield* connect()

        yield* Effect.addFinalizer(() =>
            conn.close().pipe(Effect.orDie),
        )

        return yield* conn.query(sql)
    }),
)
```

> See also: [Graceful Shutdown] in `concurrency-patterns.md` for using `addFinalizer` with `NodeRuntime.runMain`

## Resource Hierarchies

When multiple resources are acquired in a scope, they form a hierarchy with **LIFO (Last-In, First-Out) release ordering**. The last resource acquired is the first to be released.

```typescript
const program = Effect.scoped(
    Effect.gen(function* () {
        yield* Effect.log("=== Acquiring ===")
        const config = yield* managedConfig    // Acquired 1st
        const db = yield* managedDatabase      // Acquired 2nd (may depend on config)
        const cache = yield* managedCache      // Acquired 3rd (may depend on db)

        yield* doWork(db, cache)

        yield* Effect.log("=== Releasing ===")
        // Release order: cache, then db, then config (reverse of acquisition)
        // This is correct because cache may depend on db, db on config
    }),
)
```

### Nested acquireRelease

Resources can be nested. Inner resources are released before outer ones:

```typescript
const managedPool = Effect.acquireRelease(
    // Acquire: create pool with individual managed connections
    Effect.gen(function* () {
        const connections = yield* Effect.all(
            Array.from({ length: 5 }, () => connectToDatabase()),
        )
        yield* Effect.log(`Pool created with ${connections.length} connections`)
        return { connections, query: (sql: string) => /* ... */ }
    }),
    // Release: close all connections in pool
    (pool) =>
        Effect.forEach(
            pool.connections,
            (conn) => conn.close(),
            { discard: true },
        ).pipe(
            Effect.andThen(Effect.log("Pool closed")),
        ),
)
```

## Resource Pooling

**Use `Pool.make`** for reusable resource pools with automatic lifecycle management:

```typescript
import { Effect, Pool } from "effect"

const program = Effect.gen(function* () {
    const pool = yield* Pool.make({
        acquire: createDatabaseConnection(),
        size: 10,
    })

    // Borrow a connection, returned to the pool when the scope closes
    const result = yield* Effect.scoped(
        Effect.gen(function* () {
            const conn = yield* Pool.get(pool)
            return yield* conn.query("SELECT * FROM users")
        }),
    )
})
```

`Pool.get(pool)` is a module function. Call it with the pool as the argument.

### Pool Configuration

`Pool.make` takes a fixed `size`. For an elastic pool with a TTL, use `Pool.makeWithTTL`:

```typescript
const pool = yield* Pool.makeWithTTL({
    acquire: createConnection(),      // How to create a resource
    min: 2,                           // Keep at least this many
    max: 10,                          // Grow up to this many
    timeToLive: Duration.minutes(5),  // Shrink unused excess after TTL
    timeToLiveStrategy: "usage",      // TTL from last use (versus creation)
})
```

Both constructors require a `Scope`. The pool is torn down when the enclosing scope closes.

### Pool versus Manual Management

| Approach | Use Case |
|----------|----------|
| `Pool.make` / `Pool.makeWithTTL` | Fixed or elastic set of reusable resources (DB connections, HTTP clients) |
| `Effect.acquireRelease` | One-off resources created and destroyed per operation |
| `Layer.effect` | Singleton resources shared across the application |

## Scoped Service Layers

### Layer.effect Absorbs the Scope

`Layer.effect` supplies the layer `Scope` and excludes it from the layer requirements. Put the
`acquireRelease` inside the service `make`:

```typescript
import { Context, Effect, Layer } from "effect"

export class DatabasePool extends Context.Service<DatabasePool>()("DatabasePool", {
    make: Effect.gen(function* () {
        const pool = yield* Effect.acquireRelease(
            createPool({ maxConnections: 10 }),
            (pool) => pool.close().pipe(Effect.orDie),
        )

        yield* Effect.log("Database pool started")

        return {
            query: (sql: string) => pool.query(sql),
            transaction: (fn: (conn: Connection) => Effect.Effect<void>) =>
                Effect.scoped(
                    Effect.gen(function* () {
                        const conn = yield* Pool.get(pool)
                        yield* fn(conn)
                    }),
                ),
        }
    }),
}) {
    // Layer.effect handles the Scope
    static readonly layer = Layer.effect(this, this.make)
}
```

`Context.Service` defines the service with a `make` effect. `Layer.effect` builds the layer
from that effect, with scope handling included.

### Composing Scoped Layers

`Layer.mergeAll` builds its layers **concurrently**, so argument order is not acquisition order
and you cannot predict the teardown order from it:

```typescript
const InfraLive = Layer.mergeAll(
    DatabasePool.layer,
    RedisCache.layer,
    MessageQueue.layer,   // all three acquire concurrently
)
```

When one resource must exist before another is built, express that as a dependency rather than
as position. `Layer.provide` and `Layer.provideMerge` order the build, and the scope then
releases in reverse:

```typescript
// MessageQueue needs a live pool, so provide it
const InfraLive = MessageQueue.layer.pipe(
    Layer.provideMerge(DatabasePool.layer),
)
// Build: DatabasePool, then MessageQueue. Release: MessageQueue, then DatabasePool
```

Layers memoize across `Effect.provide` calls, so a scoped layer used in two places is built
once, and torn down once. Use `Layer.fresh` or `Effect.provide(layer, { local: true })` when
independent resources are needed deliberately. See `layer-patterns.md`.

> See also: `layer-patterns.md` for `Layer.mergeAll`, `Layer.provideMerge`, and dependency wiring

## Resource Timeouts

`Effect.timeoutOrElse` takes a fallback `Effect`, so wrap the error in `Effect.fail`.

### Acquisition Timeout

Prevent hanging on resource creation:

```typescript
const managedConnection = Effect.acquireRelease(
    connectToDatabase().pipe(
        Effect.timeoutOrElse({
            duration: Duration.seconds(5),
            orElse: () =>
                Effect.fail(new ConnectionTimeoutError({
                    message: "Database connection timed out",
                })),
        }),
    ),
    (conn) => conn.close().pipe(Effect.orDie),
)
```

### Per-Operation Timeout

Timeout individual operations while keeping the resource open:

```typescript
const program = Effect.scoped(
    Effect.gen(function* () {
        const conn = yield* managedConnection

        const result = yield* conn.query(sql).pipe(
            Effect.timeoutOrElse({
                duration: Duration.seconds(10),
                orElse: () => Effect.fail(new QueryTimeoutError({ message: "Query timed out" })),
            }),
        )

        return result
    }),
)
```

### Total Scope Timeout

Timeout the entire scoped operation:

```typescript
const program = Effect.scoped(
    Effect.gen(function* () {
        const conn = yield* managedConnection
        const data = yield* conn.query(sql)
        yield* processData(data)
        return data
    }),
).pipe(
    Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () =>
            Effect.fail(new OperationTimeoutError({ message: "Total operation timed out" })),
    }),
)
// Resource is still properly released even on timeout
```

Plain `Effect.timeout(duration)` fails with the built-in `TimeoutError` when a custom error is
not needed.

## ManagedRuntime versus Effect.provide

### Effect.provide (Default)

Provide layers per-effect execution. Each `Effect.runPromise` call builds and tears down the layer:

```typescript
const result = await Effect.runPromise(
    program.pipe(Effect.provide(AppLive)),
)
// Layer built, program runs, layer torn down
```

### ManagedRuntime (Long-Lived)

**Use `ManagedRuntime`** for servers and long-running processes where layers persist across multiple effect executions:

```typescript
import { ManagedRuntime } from "effect"

// Create runtime once, layers stay alive
const runtime = ManagedRuntime.make(AppLive)

// Use for multiple requests, layers are shared
server.get("/users", async (req, res) => {
    const result = await runtime.runPromise(handleGetUsers(req))
    res.json(result)
})

server.post("/users", async (req, res) => {
    const result = await runtime.runPromise(handleCreateUser(req))
    res.json(result)
})

// Dispose when server shuts down, runs all layer finalizers
process.on("SIGTERM", () => runtime.dispose())
```

Facts about `ManagedRuntime` in Effect v4:

- It is a handle, not an `Effect`, so call its run methods directly. Use `contextEffect` when
  the built context is needed inside an Effect.
- `runtime.contextEffect` and `runtime.context` expose the built context.
- `ManagedRuntime.make(layer, { memoMap })` accepts a shared memo map.
- `ManagedRuntime.ManagedRuntime.Services<T>` extracts the service type.

Available methods: `runPromise`, `runPromiseExit`, `runFork`, `runSync`, `context`,
`contextEffect`, `dispose`.

### Provide a Prebuilt Context

Use `Context` with the `run*With` functions to run an effect against services captured
elsewhere:

```typescript
const main = Effect.gen(function* () {
    const services = yield* Effect.context<Logger>()
    return Effect.runForkWith(services)(program)
})
```

The `Runtime` module contains `Teardown`, `defaultTeardown`, and `makeRunMain`.

### When to Use Each

| Approach | Use Case |
|----------|----------|
| `Effect.provide` | Scripts, CLI tools, one-shot operations |
| `ManagedRuntime.make` | HTTP servers, long-running services, multiple executions sharing resources |
| `NodeRuntime.runMain` | Application entry point with graceful shutdown |

## Quick Reference Table

| API | Import | Purpose |
|-----|--------|---------|
| `Effect.acquireRelease(acquire, release, opts?)` | `Effect` | Bracket pattern, guaranteed cleanup |
| `Effect.scoped` | `Effect` | Create scope for resource lifetime |
| `Effect.addFinalizer(fn)` | `Effect` | Register cleanup in current scope |
| `Scope.provide(scope)` | `Scope` | Provide a scope without closing it |
| `Pool.make({ acquire, size })` | `Pool` | Fixed-size reusable resource pool |
| `Pool.makeWithTTL({ acquire, min, max, timeToLive })` | `Pool` | Elastic pool with TTL |
| `Pool.get(pool)` | `Pool` | Borrow resource from pool (auto-returned) |
| `Layer.effect` | `Layer` | Build layer, scoped or not |
| `Layer.fresh(layer)` | `Layer` | Bypass shared memoization |
| `ManagedRuntime.make(layer, opts?)` | `ManagedRuntime` | Long-lived runtime sharing layers |
| `runtime.runPromise(effect)` | n/a | Run effect in managed runtime |
| `runtime.contextEffect` | n/a | Built context as an Effect |
| `runtime.dispose()` | n/a | Tear down runtime and run finalizers |
| `Effect.timeoutOrElse({ duration, orElse })` | `Effect` | Timeout with a fallback Effect |
| `Effect.runForkWith(services)` | `Effect` | Run with a prebuilt `Context` |
| `NodeRuntime.runMain(effect)` | `@effect/platform-node` | Entry point with SIGINT and SIGTERM handling |
