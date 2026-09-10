# Layer Patterns

> Effect v4. There is no auto-generated `Default` layer. Every service declares its own
> `static readonly layer`. See `service-patterns.md` for the service definition itself.

## Dependencies Belong in the Layer

**Critical rule:** a service's `static layer` must provide everything its `make` requires. A
fully-wired layer has `never` in its third type parameter; anything else is a leaked dependency
that every usage site has to patch.

### Correct Pattern

```typescript
export class OrderService extends Context.Service<OrderService>()("OrderService", {
    make: Effect.gen(function* () {
        const users = yield* UserService
        const products = yield* ProductService
        const inventory = yield* InventoryService
        const payments = yield* PaymentService

        // Service implementation...
        return { /* methods */ }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide([
            UserService.layer,
            ProductService.layer,
            InventoryService.layer,
            PaymentService.layer,
        ]),
    )
    //  ^? Layer<OrderService, E, never>, fully wired
}

// At app root - simple, flat composition
const AppLive = Layer.mergeAll(
    OrderService.layer,
    // Other top-level services
    NotificationService.layer,
    AnalyticsService.layer,
)
```

`Layer.provide` accepts an array, so one call satisfies all four dependencies. Reach for it
instead of chaining four separate `Layer.provide` calls.

### Wrong Pattern (Leaked Dependencies)

> See also: [Prop-Drilling Dependencies Through Function Arguments] in `anti-patterns.md` for the broader anti-pattern

```typescript
// WRONG - layer doesn't satisfy what make requires
export class OrderService extends Context.Service<OrderService>()("OrderService", {
    make: Effect.gen(function* () {
        const users = yield* UserService // requirement escapes
        // ...
    }),
}) {
    static readonly layer = Layer.effect(this, this.make)
    //  ^? Layer<OrderService, never, UserService | ProductService>
}

// Now every usage requires manual wiring
const program = Effect.gen(function* () {
    const orders = yield* OrderService
    return yield* orders.create(input)
}).pipe(
    Effect.provide(
        OrderService.layer.pipe(
            Layer.provide(UserService.layer),
            Layer.provide(ProductService.layer),
            // Easy to forget one, now a type error rather than a runtime surprise
        )
    ),
)
```

Because the requirement is visible in the layer's type, forgetting one is a
compile error at the definition site rather than a mystery at the app root.

## Infrastructure Layers

Infrastructure layers (Database, Redis, HTTP clients) are **acceptable** to leave as "leaked"
dependencies because:

1. They're provided once at the application root
2. They don't change between test/production (different implementations, same interface)
3. They're true infrastructure, not business logic

```typescript
// Infrastructure can be provided at app root
import { PgClient } from "@effect/sql-pg"

// Config-driven variant uses layerConfig
const DatabaseLive = PgClient.layerConfig({
    host: Config.String("DB_HOST"),
    port: Config.Int("DB_PORT"),
    database: Config.String("DB_NAME"),
    username: Config.String("DB_USER"),
    password: Config.Redacted("DB_PASSWORD"),
})

// Services use the database but don't provide it in their own layer
export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
    make: Effect.gen(function* () {
        const sql = yield* PgClient.PgClient

        const findById = Effect.fn("UserRepo.findById")(function* (id: UserId) {
            const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`.pipe(Effect.orDie)
            return rows[0] as User | undefined
        })

        return { findById }
    }),
}) {
    // Deliberately leaves PgClient in the requirements, provided at app root
    static readonly layer = Layer.effect(this, this.make)
}

// App root provides infrastructure once
const AppLive = Layer.mergeAll(
    OrderService.layer,
    UserService.layer,
).pipe(
    Layer.provide(DatabaseLive), // Infrastructure provided here
    Layer.provide(RedisLive),
)
```

## Layer.mergeAll Over Nested Provides

**Use `Layer.mergeAll`** for composing layers at the same level:

```typescript
// CORRECT - Flat composition
const ServicesLive = Layer.mergeAll(
    UserService.layer,
    OrderService.layer,
    ProductService.layer,
    NotificationService.layer,
)

const InfrastructureLive = Layer.mergeAll(
    DatabaseLive,
    RedisLive,
    HttpClientLive,
)

const AppLive = ServicesLive.pipe(
    Layer.provide(InfrastructureLive),
)
```

```typescript
// WRONG - Deeply nested, hard to read
const AppLive = UserService.layer.pipe(
    Layer.provide(
        OrderService.layer.pipe(
            Layer.provide(
                ProductService.layer.pipe(
                    Layer.provide(DatabaseLive),
                ),
            ),
        ),
    ),
)
```

## Layer.provideMerge for Sequential Composition

**Use `Layer.provideMerge`** when chaining layers that need incremental composition. Unlike
`Layer.provide`, `provideMerge` merges the output into the current layer, producing flatter
types.

```typescript
// CORRECT - Layer.provideMerge chains for incremental composition
const MainLive = DatabaseLive.pipe(
    Layer.provideMerge(ProxyConfigService.layer),
    Layer.provideMerge(LoggerLive),
    Layer.provideMerge(CacheLive),
    Layer.provideMerge(TracerLive),
)

// WRONG - Multiple Layer.provide calls create nested types
const MainLive = DatabaseLive.pipe(
    Layer.provide(ProxyConfigService.layer),
    Layer.provide(LoggerLive),  // Each provide creates deeper nesting
    Layer.provide(CacheLive),
)
```

**Key difference:** `Layer.provide(A, B)` provides B to A but outputs only A's services.
`Layer.provideMerge(A, B)` provides B to A and outputs both A's and B's services merged
together.

## Layer Memoization

Layers memoize construction. The same service is instantiated only once regardless of how many
times it appears in the dependency graph.

```typescript
// Both UserRepo and OrderRepo depend on DatabaseLive
const RepoLive = Layer.mergeAll(
    UserRepo.layer,   // requires DatabaseLive
    OrderRepo.layer,  // requires DatabaseLive
)

// DatabaseLive is constructed ONCE
const AppLive = RepoLive.pipe(
    Layer.provide(DatabaseLive), // Single instance shared
)
```

### Shared memoization across `Effect.provide` calls

The `MemoMap` is shared across provide calls on the same fiber, so overlapping layers build
one instance. This avoids duplicate database pools:

```typescript
// DatabaseLive built ONCE.
const program = myEffect.pipe(
    Effect.provide(UserRepo.layer),
    Effect.provide(OrderRepo.layer),
)
```

**This is a safety net, not a license.** Compose layers before providing. It keeps the whole
dependency graph visible in one place:

```typescript
// PREFERRED - one composed layer, one provide
const program = myEffect.pipe(Effect.provide(AppLive))
```

### Opting out: fresh instances on purpose

Sometimes you *want* a separate instance, for test isolation or independent connection pools:

```typescript
// Layer.fresh - this layer bypasses the shared memo map
const program = myEffect.pipe(
    Effect.provide(DatabaseLive),
    Effect.provide(Layer.fresh(DatabaseLive)), // built again, separately
)

// { local: true } isolates an entire layer subtree
const program = myEffect.pipe(
    Effect.provide(AppLive),
    Effect.provide(TestHarnessLive, { local: true }), // own memo map
)
```

Use `{ local: true }` when a whole subtree must be independent, e.g. per-test resources.

## TypeScript LSP Performance

Deeply nested `Layer.provide` chains create complex recursive types that slow down the
TypeScript Language Server.

```typescript
// PROBLEMATIC - Deep nesting causes slow LSP
const AppLive = Layer1.pipe(
    Layer.provide(Layer2.pipe(
        Layer.provide(Layer3.pipe(
            Layer.provide(Layer4.pipe(
                Layer.provide(Layer5),
            )),
        )),
    )),
)
// Type becomes: Layer<..., Layer<..., Layer<..., Layer<..., ...>>>>
```

```typescript
// BETTER - Flat composition with mergeAll produces simpler types
const InfraLive = Layer.mergeAll(Layer3, Layer4, Layer5)
const AppLive = Layer.mergeAll(Layer1, Layer2).pipe(
    Layer.provide(InfraLive),
)
// Type is flatter and LSP responds faster
```

**Recommendations:**

- Prefer `Layer.mergeAll` for layers at the same level
- Pass an array to a single `Layer.provide` rather than chaining calls
- Use `Layer.provideMerge` when you need the provided services in the output
- Group related layers into intermediate compositions
- Keep nesting depth shallow (ideally 2-3 levels max)

## layerConfig Pattern

For services that need configuration at construction time, add a `layerConfig` static
alongside `layer`:

```typescript
import { Config, Context, Effect, Layer } from "effect"

interface EventQueueConfig {
    readonly maxRetries: number
    readonly batchSize: number
    readonly pollInterval: number
}

export class ElectricEventQueue extends Context.Service<ElectricEventQueue>()(
    "ElectricEventQueue",
    {
        make: Effect.gen(function* () {
            // Default implementation
            return { /* methods */ }
        }),
    }
) {
    static readonly layer = Layer.effect(this, this.make)

    // Config-driven variant
    static readonly layerConfig = (
        config: Config.Wrap<EventQueueConfig>,
    ): Layer.Layer<ElectricEventQueue, Config.ConfigError> =>
        Layer.unwrap(
            Config.unwrap(config).pipe(
                Effect.map((cfg) =>
                    Layer.succeed(
                        ElectricEventQueue,
                        new ElectricEventQueueImpl(cfg)
                    )
                )
            )
        )
}

// Usage
const EventQueueLive = ElectricEventQueue.layerConfig({
    maxRetries: Config.Int("EVENT_QUEUE_MAX_RETRIES").pipe(
        Config.withDefault(3)
    ),
    batchSize: Config.Int("EVENT_QUEUE_BATCH_SIZE").pipe(
        Config.withDefault(100)
    ),
    pollInterval: Config.Int("EVENT_QUEUE_POLL_INTERVAL").pipe(
        Config.withDefault(1000)
    ),
})
```

Details in that example: the wrapper type is `Config.Wrap<T>`,
the error is `Config.ConfigError`, integer config uses
`Config.Int`, and effect lifting uses `Layer.unwrap`.

This pattern:

- Separates configuration from implementation
- Returns `ConfigError` for missing/invalid config
- Allows different configs per environment
- Integrates cleanly with `Layer.mergeAll` and `Layer.provideMerge`

## Layer Naming Conventions

Use `layer` as the primary layer name. Use descriptive suffixes for variants:

| Name | Purpose |
| --- | --- |
| `Service.layer` | production implementation |
| `Service.layerConfig` | built from `Config` values |
| `Service.layerTest` | test / mock implementation |

Standalone infrastructure layers that aren't attached to a service class may still use a
`Live` suffix (`DatabaseLive`, `RedisLive`), since there is no class to hang a static on.

```typescript
// Test with a static double
export const UserServiceTest = Layer.succeed(
    UserService,
    UserService.of({
        findById: (id) => Effect.succeed(mockUser),
        create: (input) => Effect.succeed({ id: UserId.make("test-id"), ...input }),
    })
)

// Test with in-memory state, a second layer on the SAME class,
// so production code yielding UserService gets the mock
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () { /* real implementation */ }),
}) {
    static readonly layer = Layer.effect(this, this.make)

    static readonly layerTest = Layer.effect(
        this,
        Effect.gen(function* () {
            const store = new Map<string, User>()

            return {
                findById: Effect.fn("UserService.findById")(function* (id) {
                    const user = store.get(id)
                    if (!user) return yield* Effect.fail(new UserNotFoundError({ userId: id }))
                    return user
                }),
                create: Effect.fn("UserService.create")(function* (input) {
                    const user = { id: UserId.make(crypto.randomUUID()), ...input }
                    store.set(user.id, user)
                    return user
                }),
            }
        }),
    )
}
```

A *separate* mock class also works, because context lookup is by the identifier **string**, so
`class UserServiceInMemory extends Context.Service<UserService>()("UserService", ...)` occupies
the same slot. But that match is an unchecked convention: a typo in the string silently yields a
different service and the failure shows up as a missing-requirement error somewhere else.
`static layerTest` on the real class can't drift.

## Layer.unwrap for Config-Dependent Layers

When a layer's construction depends on an effect:

```typescript
import { Config, Effect, Layer, Schema } from "effect"

// Layer that depends on config
const ApiClientLive = Layer.unwrap(
    Effect.gen(function* () {
        const apiKey = yield* Config.String("API_KEY")
        const baseUrl = yield* Config.String("API_BASE_URL")
        const timeout = yield* Config.Int("API_TIMEOUT").pipe(
            Config.withDefault(5000)
        )

        return Layer.succeed(
            ApiClient,
            new ApiClientImpl({ apiKey, baseUrl, timeout })
        )
    })
)

// Layer that validates config. Put the rule on the schema and let
// Config.schema turn a failed check into a ConfigError for you
const DbUrl = Config.schema(
    Schema.String.check(Schema.isStartsWith("postgresql://")),
    "DATABASE_URL",
)

const ValidatedConfigLive = Layer.unwrap(
    Effect.gen(function* () {
        const config = yield* Config.all({
            dbUrl: DbUrl,
            redisUrl: Config.String("REDIS_URL"),
            port: Config.Port("PORT"),
        })

        return Layer.succeed(AppConfig, config)
    })
)
```

Validate through `Config.schema(schema.check(...), path)` rather than hand rolling the failure.
`ConfigError` is not constructible from a message: its constructor takes a
`SourceError | Schema.SchemaError`, and `message` is a getter derived from that cause.

## Scoped Layers

`Layer.effect` handles scoped acquisition. It supplies
the layer's `Scope` and excludes it from the requirements:

```typescript
import { Context, Effect, Layer } from "effect"

// Resource that needs cleanup, Layer.effect handles the Scope
const DatabaseConnectionLive = Layer.effect(
    DatabaseConnection,
    Effect.acquireRelease(
        Effect.gen(function* () {
            const pool = yield* createPool(config)
            yield* Effect.log("Database pool created")
            return pool
        }),
        (pool) =>
            Effect.gen(function* () {
                yield* pool.end()
                yield* Effect.log("Database pool closed")
            }).pipe(Effect.orDie)
    )
)

// Service using scoped resource
export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
    make: Effect.gen(function* () {
        const db = yield* DatabaseConnection

        return {
            findById: Effect.fn("UserRepo.findById")(function* (id) {
                return yield* db.query("SELECT * FROM users WHERE id = $1", [id])
            }),
        }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide(DatabaseConnectionLive),
    )
}
```

## Testing Layer Composition

```typescript
// test/setup.ts
import { Layer } from "effect"

export const TestLive = Layer.mergeAll(
    UserService.layerTest,
    OrderService.layerTest,
    ProductService.layerTest,
).pipe(
    Layer.provide(InMemoryDatabaseLive),
)

// test/user.test.ts
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestLive } from "./setup"

describe("UserService", () => {
    it.effect("creates users", () =>
        Effect.gen(function* () {
            const users = yield* UserService
            const user = yield* users.create({
                email: "test@example.com",
                name: "Test User",
            })
            assert.strictEqual(user.email, "test@example.com")
        }).pipe(Effect.provide(TestLive))
    )
})
```

See `testing-patterns.md` for the full test setup.

## Layer.effect vs Layer.succeed

```typescript
// Layer.succeed - for static values (no effects)
const ConfigLive = Layer.succeed(AppConfig, {
    port: 3000,
    env: "development",
})

// Layer.effect - when construction needs effects (including scoped acquisition)
const LoggerLive = Layer.effect(
    Logger,
    Effect.gen(function* () {
        const config = yield* AppConfig
        const transport = config.env === "production"
            ? createCloudTransport()
            : createConsoleTransport()
        return new LoggerImpl(transport)
    })
)
```

## Deferred Layer Construction

For expensive initialization that should be deferred, use `Layer.suspend`:

```typescript
const ExpensiveServiceLive = Layer.suspend(() => {
    // This code runs only when the layer is first used
    return Layer.effect(
        ExpensiveService,
        Effect.gen(function* () {
            yield* Effect.log("Initializing expensive service...")
            const client = yield* createExpensiveClient()
            return new ExpensiveServiceImpl(client)
        })
    )
})
```
