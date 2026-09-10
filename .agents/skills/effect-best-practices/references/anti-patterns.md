# Anti-Patterns (Forbidden)

These patterns are **never acceptable** in Effect code. Each is listed with rationale and the correct alternative.

> **Effect v4.** Examples use `Context.Service` and `Effect.catch`.

## FORBIDDEN: Effect.runSync/runPromise Inside Services

```typescript
// FORBIDDEN
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () {
        const findById = (id: UserId) => {
            // Running effects synchronously breaks composition
            const user = Effect.runSync(repo.findById(id))
            return user
        }
        return { findById }
    }),
}) {}
```

**Why:** Breaks Effect composition model, loses error handling, cannot be tested, loses tracing.

**Correct:**

```typescript
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    return yield* repo.findById(id)
})
```

## FORBIDDEN: throw Inside Effect.gen

```typescript
// FORBIDDEN
yield* Effect.gen(function* () {
    const user = yield* repo.findById(id)
    if (!user) {
        throw new Error("User not found") // Bypasses Effect error channel
    }
    return user
})
```

**Why:** Throws bypass Effect error channel, cannot be caught with `catchTag`, breaks type safety.

**Correct:**

```typescript
yield* Effect.gen(function* () {
    const user = yield* repo.findById(id)
    if (!user) {
        return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" }))
    }
    return user
})
```

## FORBIDDEN: Effect.catch Losing Type Information

```typescript
// FORBIDDEN
yield* someEffect.pipe(
    Effect.catch((err) =>
        Effect.fail(new GenericError({ message: "Something failed" }))
    )
)
```

**Why:** Loses specific error information, makes debugging harder, prevents specific error handling downstream.

**Correct:**

```typescript
yield* someEffect.pipe(
    Effect.catchTags({
        DatabaseError: (err) => Effect.fail(new ServiceUnavailableError({ message: err.message })),
        ValidationError: (err) => Effect.fail(new BadRequestError({ message: err.message })),
    }),
)
```

## FORBIDDEN: any/unknown Casts

```typescript
// FORBIDDEN
const data = someValue as any
const result = (await fetch(url)) as unknown as MyType
```

**Why:** Completely bypasses type safety, can cause runtime errors, loses Effect type guarantees.

**Correct:**

```typescript
// Use Schema for parsing unknown data
const result = yield* Schema.decodeUnknownEffect(MyType)(someValue)

// Or explicit type guards
if (isMyType(someValue)) {
    // Now safely typed
}
```

## FORBIDDEN: Promise in Service Signatures

```typescript
// FORBIDDEN
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () {
        return {
            findById: async (id: UserId): Promise<User> => {
                // Using Promise instead of Effect
            }
        }
    }),
}) {}
```

**Why:** Loses Effect error handling, cannot compose with other Effects, loses tracing and metrics.

**Correct:**

```typescript
const findById = Effect.fn("UserService.findById")(
    function* (id: UserId): Effect.Effect<User, UserNotFoundError> {
        // ...
    }
)
```

## FORBIDDEN: console.log

```typescript
// FORBIDDEN
console.log("Processing order:", orderId)
console.error("Error:", error)
```

**Why:** Not structured, not captured by Effect logging system, lost in production telemetry.

**Correct:**

```typescript
yield* Effect.log("Processing order", { orderId })
yield* Effect.logError("Operation failed", { error: String(error) })
```

## FORBIDDEN: process.env Directly

```typescript
// FORBIDDEN
const apiKey = process.env.API_KEY
const port = parseInt(process.env.PORT || "3000")
```

**Why:** No validation, no type safety, fails silently if missing, hard to test.

**Correct:**

```typescript
const config = yield* Config.all({
    apiKey: Config.Redacted("API_KEY"),
    port: Config.Int("PORT").pipe(Config.withDefault(3000)),
})
```

## FORBIDDEN: Logging Redacted Secrets

```typescript
// FORBIDDEN
const program = Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("API_KEY")
    yield* Effect.log("Using key", { key: Redacted.value(apiKey) }) // leaks the secret
    return apiKey
})
```

**Why:** Unwrapping a `Redacted` value into logs exposes secrets in plain text in telemetry.

**Correct:**

```typescript
import { Config, Redacted } from "effect"

const secretConfig = Config.all({
    apiKey: Config.Redacted("API_KEY"), // Returns Redacted<string>
    dbPassword: Config.Redacted("DB_PASSWORD"),
})

// Using redacted values, unwrap only at the boundary that needs the raw value
const program = Effect.gen(function* () {
    const { apiKey } = yield* secretConfig
    yield* Effect.log("API key loaded", { key: apiKey }) // Redacted stays opaque
    const key = Redacted.value(apiKey) // Unwrap when calling the external client
})

// To redact a non-string config, map it
const secretNumber = Config.map(Config.Int("SECRET_PORT"), Redacted.make)
//    ^? Config<Redacted<number>>
```

## FORBIDDEN: null/undefined in Domain Types

```typescript
// FORBIDDEN
type User = {
    name: string
    bio: string | null
    avatar: string | undefined
}
```

**Why:** Null and undefined handling is error prone, loses the explicit absence semantics.

**Correct:**

```typescript
const User = Schema.Struct({
    name: Schema.String,
    bio: Schema.Option(Schema.String),
    avatar: Schema.Option(Schema.String),
})
```

## FORBIDDEN: Option.getOrThrow

```typescript
// FORBIDDEN
const user = Option.getOrThrow(maybeUser)
const name = pipe(maybeName, Option.getOrThrow)
```

**Why:** Throws exceptions, bypasses Effect error handling, fails at runtime instead of compile time.

**Correct:**

```typescript
// Handle both cases explicitly
yield* Option.match(maybeUser, {
    onNone: () => Effect.fail(new UserNotFoundError({ userId, message: "Not found" })),
    onSome: Effect.succeed,
})

// Or provide a default
const name = Option.getOrElse(maybeName, () => "Anonymous")

// Or use Option.map for transformations
const upperName = Option.map(maybeName, (n) => n.toUpperCase())
```

## FORBIDDEN: A Business Service Without `make` and a Wired Layer

```typescript
// FORBIDDEN: a bare key for business logic, wired ad hoc at every call site
export class UserService extends Context.Service<
    UserService,
    { findById: (id: UserId) => Effect.Effect<User, UserNotFoundError> }
>()("UserService") {}

// Every usage site has to build and provide the implementation itself
program.pipe(Effect.provideService(UserService, { findById: ... }))
```

**Why:** The construction logic has no single home, so it gets duplicated and drifts. Nothing
declares the service own dependencies, so every caller has to know them.

**Correct:** give the service a `make` and a `static layer` that satisfies everything `make`
requires:

```typescript
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () {
        const repo = yield* UserRepo
        const findById = Effect.fn("UserService.findById")(function* (id: UserId) { ... })
        return { findById }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide(UserRepo.layer),
    )
}
```

A service **without** `make` is correct for infrastructure injected by the runtime
(Cloudflare KV, worker bindings). The anti-pattern is using that shape for logic you construct
yourself. See `service-patterns.md`.

## FORBIDDEN: Yielding Non-Effect Values

```typescript
// FORBIDDEN
const value = yield* ref        // Ref is a plain value, use Ref.get
const result = yield* deferred  // Deferred is a plain value, use Deferred.await
const output = yield* fiber     // Fiber is a plain value, use Fiber.join
const n = yield* Option.some(1) // Option is a plain value, use Effect.fromOption
```

**Why:** `Ref`, `Deferred`, `Fiber`, and `Option` are plain values, not `Effect` subtypes.
Yielding them directly is a type error that hides intent. The ambiguity between "I have a Ref"
and "I have an Effect that reads the Ref" causes silent bugs (for example
`Effect.all([refA, refB])` reading both when you meant to pass the handles).

**Correct:**

```typescript
const value = yield* Ref.get(ref)
const result = yield* Deferred.await(deferred)
const output = yield* Fiber.join(fiber)
const n = yield* Effect.fromOption(Option.some(1))
```

`Config` and `Context.Service` keys extend `Effect`, so those yield directly and also pass to
combinators unchanged.

## FORBIDDEN: Ignoring Errors with orDie

```typescript
// FORBIDDEN (in most cases)
yield* someEffect.pipe(Effect.orDie)
```

**Why:** Converts recoverable errors to defects (unrecoverable), loses error information.

**Acceptable exceptions:**

- Truly unrecoverable situations (invalid program state)
- After exhausting all recovery options
- In test setup code

**Correct:**

```typescript
// Handle errors explicitly
yield* someEffect.pipe(
    Effect.catchTag("RecoverableError", (err) =>
        Effect.fail(new DomainError({ message: err.message }))
    ),
)
```

## FORBIDDEN: mapError Instead of catchTag

```typescript
// FORBIDDEN
yield* effect.pipe(
    Effect.mapError((err) => new GenericError({ message: String(err) }))
)
```

**Why:** Loses error type information, cannot discriminate between error types.

**Correct:**

```typescript
yield* effect.pipe(
    Effect.catchTag("SpecificError", (err) =>
        Effect.fail(new MappedError({ message: err.message }))
    ),
)
```

## FORBIDDEN: Mixing Effect and Promise Chains

```typescript
// FORBIDDEN
const result = await someEffect.pipe(
    Effect.runPromise,
).then(data => {
    // Mixing Promise chain with Effect
    return Effect.runPromise(anotherEffect(data))
})
```

**Why:** Loses Effect composition benefits, error handling becomes inconsistent.

**Correct:**

```typescript
const program = Effect.gen(function* () {
    const data = yield* someEffect
    return yield* anotherEffect(data)
})

const result = await Effect.runPromise(program)
```

## FORBIDDEN: Mutable State Without Ref

```typescript
// FORBIDDEN
let counter = 0
const increment = Effect.sync(() => { counter++ })
```

**Why:** Race conditions, not testable, not composable, breaks referential transparency.

**Correct:**

```typescript
const program = Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    yield* Ref.update(counter, (n) => n + 1)
    return yield* Ref.get(counter)
})
```

## FORBIDDEN: Using Date.now() or new Date() Directly

```typescript
// FORBIDDEN
const now = new Date()
const timestamp = Date.now()
```

**Why:** Not testable, introduces non-determinism, hard to mock in tests.

**Correct:**

```typescript
import { Clock, DateTime, Effect } from "effect"

const now = yield* Clock.currentTimeMillis
const date = yield* Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms))

// Or stay in Effect's own time type, which carries a zone
const utc = yield* DateTime.now
const zoned = yield* DateTime.nowInCurrentZone
```

`DateTime.nowInCurrentZone` requires `CurrentTimeZone`, a `Context.Reference`, so tests can pin
the zone with `Effect.provideService`.

## FORBIDDEN: Deeply Nesting flatMap/andThen Chains

```typescript
// FORBIDDEN
step1().pipe(
    Effect.flatMap((a) =>
        step2(a).pipe(
            Effect.flatMap((b) =>
                step3(b).pipe(
                    Effect.flatMap((c) => step4(c))
                )
            )
        )
    )
)
```

**Why:** Creates callback hell, difficult to read, debug, and maintain. Effect provides `Effect.gen` specifically to avoid this.

**Correct:**

```typescript
const program = Effect.gen(function* () {
    const a = yield* step1()
    const b = yield* step2(a)
    const c = yield* step3(b)
    return yield* step4(c)
})
```

## FORBIDDEN: Treating Effects as Eager (Like Promises)

```typescript
// FORBIDDEN, assuming Effect executes on creation
const myEffect = Effect.log("Hello") // Nothing happens here!
// Unlike Promises, Effects are lazy blueprints
const myPromise = Promise.resolve("Hello") // Executes immediately

// FORBIDDEN, storing Effect results without yielding
const result = Effect.succeed(42) // This is an Effect, not 42
```

**Why:** Effects are lazy, immutable blueprints. They describe computations but do nothing until explicitly run with `Effect.runPromise`, `Effect.runSync`, or yielded inside `Effect.gen`. Treating them as eager leads to code that silently does nothing.

**Correct:**

```typescript
const program = Effect.gen(function* () {
    yield* Effect.log("Hello") // Executed when program is run
    const result = yield* Effect.succeed(42) // result is now 42
})

// Execute the blueprint
Effect.runPromise(program)
```

## FORBIDDEN: Manual try/finally for Resource Cleanup

```typescript
// FORBIDDEN
const program = Effect.gen(function* () {
    const connection = yield* getDbConnection()
    try {
        return yield* useConnection(connection)
    } finally {
        // yield* CANNOT be used inside finally blocks!
        yield* closeConnection(connection) // This does not work correctly
    }
})
```

**Why:** `yield*` cannot be used inside `finally` blocks in generators. The cleanup effect does not execute properly. Manual cleanup is not interruption safe. If the fiber is interrupted, the `finally` block may not run.

**Correct:**

```typescript
const program = Effect.acquireRelease(
    getDbConnection(),                       // acquire
    (connection) => closeConnection(connection) // release (guaranteed)
).pipe(
    Effect.flatMap((connection) => useConnection(connection))
)

// Run with scoped to manage the resource lifecycle
Effect.runPromise(Effect.scoped(program))
```

## FORBIDDEN: Manual Retry/Timeout Logic

```typescript
// FORBIDDEN
async function fetchWithRetry() {
    for (let i = 0; i < 3; i++) {
        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 2000)
            const response = await fetch("https://api.example.com", {
                signal: controller.signal,
            })
            clearTimeout(timeoutId)
            return await response.json()
        } catch (error) {
            if (i === 2) throw error
            await new Promise((res) => setTimeout(res, 100 * 2 ** i))
        }
    }
}
```

**Why:** Verbose, error prone, does not compose, hard to test. Effect provides declarative, composable retry and timeout combinators.

**Correct:**

```typescript
import { Duration, Effect, Schedule } from "effect"

const retryPolicy = Schedule.exponential(Duration.millis(100)).pipe(
    Schedule.upTo({ times: 3 }),
)

const result = yield* api.fetchData().pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.retry(retryPolicy),
)
```

## FORBIDDEN: Leaking Implementation Errors Across Boundaries

```typescript
// FORBIDDEN, exposing database errors through the service API
const findUser = (): Effect.Effect<
    User,
    ConnectionError | QueryError // Leaks infrastructure details!
> => dbQuery()
```

**Why:** Consumers of `findUser` should not know about database specific errors. If you swap the database, all callers must change. This is a leaky abstraction.

**Correct:**

```typescript
class RepositoryError extends Data.TaggedError("RepositoryError")<{
    readonly cause: unknown
}> {}

const findUser = (): Effect.Effect<User, RepositoryError> =>
    dbQuery().pipe(
        Effect.mapError((error) => new RepositoryError({ cause: error }))
    )
```

## FORBIDDEN: Duplicating Error Handling in Every Route Handler

```typescript
// FORBIDDEN
const userRoute = HttpApiEndpoint.get("getUser", "/users/:id", {
    params: { id: Schema.String },
    success: UserSchema,
})

// Manually catching and mapping errors in each handler implementation
const handleGetUser = HttpApiBuilder.endpoint(Api, "users", "getUser", ({ params }) =>
    findUser(params.id).pipe(
        Effect.catchTag("UserNotFoundError", (e) =>
            Effect.fail(new ServiceError({ status: 404, message: e.message }))
        ),
    )
)

// Same error handling duplicated in every route...
const handleDeleteUser = HttpApiBuilder.endpoint(Api, "users", "deleteUser", ({ params }) =>
    deleteUser(params.id).pipe(
        Effect.catchTag("UserNotFoundError", (e) =>
            Effect.fail(new ServiceError({ status: 404, message: e.message }))
        ),
    )
)
```

**Why:** DRY violation. Error to status mapping is duplicated across every handler, making it easy to be inconsistent and hard to maintain.

**Correct:**

```typescript
// Annotate the error type once with its HTTP status
class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
    "UserNotFoundError",
    { id: Schema.String, message: Schema.String },
    { httpApiStatus: 404 },
) {}

// Declare the error on the endpoint, mapping is automatic
const endpoint = HttpApiEndpoint.get("getUser", "/users/:id", {
    params: { id: Schema.String },
    success: UserSchema,
    error: UserNotFoundError,
})

// Handlers just fail normally, no manual mapping needed
const handleGetUser = HttpApiBuilder.endpoint(Api, "users", "getUser", ({ params }) =>
    findUser(params.id) // UserNotFoundError automatically becomes 404
)
```

## FORBIDDEN: Prop-Drilling Dependencies Through Function Arguments

```typescript
// FORBIDDEN
const processOrder = (
    db: Database,
    logger: Logger,
    mailer: Mailer,
    config: AppConfig,
) => {
    logger.log("Processing order")
    const order = db.findOrder(orderId)
    mailer.send(order.email, "Order confirmed")
}

// Every caller must thread all dependencies
processOrder(db, logger, mailer, config)
```

**Why:** Does not scale. Adding a dependency forces changes in every caller up the chain. Makes refactoring painful and testing difficult.

**Correct:**

```typescript
export class OrderService extends Context.Service<OrderService>()("OrderService", {
    make: Effect.gen(function* () {
        const db = yield* Database
        const mailer = yield* Mailer

        const processOrder = Effect.fn("OrderService.processOrder")(
            function* (orderId: OrderId) {
                yield* Effect.log("Processing order")
                const order = yield* db.findOrder(orderId)
                yield* mailer.send(order.email, "Order confirmed")
            }
        )

        return { processOrder }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide([Database.layer, Mailer.layer]),
    )
}

// Callers just use the service, no dependency threading
const program = Effect.gen(function* () {
    const orderService = yield* OrderService
    yield* orderService.processOrder(orderId)
})
```

## FORBIDDEN: Using Impure Functions Directly in Business Logic

```typescript
// FORBIDDEN
const createUser = Effect.gen(function* () {
    const id = crypto.randomUUID()       // Not testable
    const timestamp = Math.random()      // Non-deterministic
    const data = await fetch("/api/data") // Side effect, not tracked
    return { id, timestamp, data }
})
```

**Why:** Impure functions (`Math.random()`, `crypto.randomUUID()`, raw `fetch()`) are non-deterministic and create untestable code. They cannot be mocked without monkey patching, and their side effects are not tracked by Effect.

**Correct:**

```typescript
export class IdGenerator extends Context.Service<IdGenerator>()("IdGenerator", {
    make: Effect.sync(() => ({
        generate: Effect.sync(() => crypto.randomUUID()),
    })),
}) {
    static readonly layer = Layer.effect(this, this.make)
}

const createUser = Effect.gen(function* () {
    const idGen = yield* IdGenerator
    const clock = yield* Clock
    const id = yield* idGen.generate
    const timestamp = yield* clock.currentTimeMillis
    return { id, timestamp }
})

// In tests: provide deterministic implementations
const TestIdGenerator = Layer.succeed(IdGenerator, {
    generate: Effect.succeed("test-uuid-123"),
})
```

## FORBIDDEN: Fork + Immediate Join (Pointless Fork)

```typescript
// FORBIDDEN
const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(someEffect)
    const result = yield* Fiber.join(fiber) // Immediately waiting, why fork?
    return result
})
```

**Why:** Forking and immediately joining is equivalent to running the effect directly, but with unnecessary overhead of creating a fiber. Fork is for true concurrency, running something in the background while doing other work.

**Correct:**

```typescript
// If you need the result immediately, just yield directly
const program = Effect.gen(function* () {
    const result = yield* someEffect
    return result
})

// Fork is for true background work
const withBackground = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(backgroundTask) // Runs independently
    const mainResult = yield* doMainWork()           // Main work continues
    yield* Fiber.interrupt(fiber)                     // Clean up when done
    return mainResult
})
```
