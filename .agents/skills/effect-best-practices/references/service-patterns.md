# Service Patterns

> Effect v4. Every service is a `Context.Service`.

## Context.Service Is the Service Constructor

Prefer the class syntax, where the class value is the context key.

```typescript
import { Context } from "effect"

class Database extends Context.Service<Database, {
    readonly query: (sql: string) => Effect.Effect<ReadonlyArray<Row>, SqlError>
}>()("Database") {}
```

Note the argument order: the type parameters come first via `Context.Service<Self, Shape>()`,
then the identifier string is passed to the returned constructor `("Database")`.

### Basic Service Definition

For a service with an effectful constructor, pass `make` and build the layer explicitly:

```typescript
import { Context, Effect, Layer } from "effect"

export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () {
        const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
            // Implementation
        })

        const findByEmail = Effect.fn("UserService.findByEmail")(function* (email: string) {
            // Implementation
        })

        const create = Effect.fn("UserService.create")(function* (input: CreateUserInput) {
            // Implementation
        })

        return { findById, findByEmail, create }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make)
}
```

Three facts define this shape:

1. `make` holds the construction effect.
2. You write `static readonly layer` explicitly with `Layer.effect`.
3. Call sites access the service with `yield*`, as shown below.

### Layer Naming Convention

Name the primary layer `layer`. Use descriptive suffixes for variants:

| Layer | Purpose |
| --- | --- |
| `Service.layer` | the primary, production layer |
| `Service.layerConfig` | built from `Config` values |
| `Service.layerTest` | test double |

### Service with Dependencies

Wire dependencies into the layer with `Layer.provide`:

```typescript
export class OrderService extends Context.Service<OrderService>()("OrderService", {
    make: Effect.gen(function* () {
        const users = yield* UserService
        const products = yield* ProductService
        const inventory = yield* InventoryService

        const create = Effect.fn("OrderService.create")(function* (input: CreateOrderInput) {
            // Validate user exists
            const user = yield* users.findById(input.userId)

            // Check product availability
            const product = yield* products.findById(input.productId)
            const available = yield* inventory.checkAvailability(input.productId, input.quantity)

            if (!available) {
                return yield* Effect.fail(new InsufficientInventoryError({
                    productId: input.productId,
                    message: "Not enough inventory",
                }))
            }

            // Create order...
        })

        return { create }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide([UserService.layer, ProductService.layer, InventoryService.layer]),
    )
}
```

`OrderService.layer` is `Layer<OrderService, E, never>`. The dependencies are satisfied
inside it, so usage sites provide one layer, not four.

### Wrong: Leaving Dependencies Unsatisfied

> See also: [Prop-Drilling Dependencies Through Function Arguments] in `anti-patterns.md`

```typescript
// WRONG, layer does not provide what `make` requires
export class OrderService extends Context.Service<OrderService>()("OrderService", {
    make: Effect.gen(function* () {
        const users = yield* UserService  // requirement escapes into the layer type
        // ...
    }),
}) {
    static readonly layer = Layer.effect(this, this.make)
    //                      ^? Layer<OrderService, never, UserService>
}

// Now every usage site must patch the hole:
const program = Effect.gen(function* () {
    const orders = yield* OrderService
    return yield* orders.create(input)
}).pipe(
    Effect.provide(OrderService.layer),
    Effect.provide(UserService.layer),  // Annoying and error prone
)
```

The leak is visible in the type: a third type parameter on `Layer` that is not `never` means
a missing `Layer.provide`.

## Access Services with `yield*`

The standard access pattern is `yield*` inside `Effect.gen`. It keeps the dependency visible
in the `Effect` `R` channel:

```typescript
// CORRECT, dependency is explicit in the Effect R channel
const program = Effect.gen(function* () {
    const users = yield* UserService
    return yield* users.findById(userId)
})
```

`use` and `useSync` exist as concise escapes, but reach for them sparingly. The service is
available inside the callback while the dependency stays invisible at the call site, which
makes it easy to leak requirements into return values:

```typescript
//      ┌─── Effect<User, UserNotFoundError, UserService>
//      ▼
const program = UserService.use((users) => users.findById(userId))

//      ┌─── Effect<number, never, AppConfig>
//      ▼
const port = AppConfig.useSync((c) => c.port)
```

`use` takes `(service: Shape) => Effect<A, E, R>`; `useSync` takes a pure `(service: Shape) => A`.
Both return Effects. `useSync` only means the callback itself is synchronous.

## Effect.fn for Tracing

**Always wrap service methods with `Effect.fn`.** It provides automatic
tracing with meaningful span names.

### Naming Convention

Use `ServiceName.methodName` format for span names:

```typescript
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    yield* Effect.annotateCurrentSpan("userId", id)
    // Implementation
})

const processPayment = Effect.fn("PaymentService.processPayment")(
    function* (orderId: OrderId, amount: number, currency: string) {
        yield* Effect.annotateCurrentSpan("orderId", orderId)
        yield* Effect.annotateCurrentSpan("amount", amount)
        yield* Effect.annotateCurrentSpan("currency", currency)
        // Implementation
    }
)
```

Use `Effect.fnUntraced` for hot paths where the span overhead is not worth it, or for functions
that only wrap an `Effect.gen` and do not need their own span.

### Second Argument Transforms Errors

Arguments after the generator body act as pipe transforms. Each transform receives the
built `Effect` and the original function arguments, which supports local error mapping
with full access to inputs:

```typescript
const findById = Effect.fn("UserService.findById")(
    function* (id: UserId) {
        return yield* repo.findById(id)
    },
    (effect, id) =>
        effect.pipe(
            Effect.catchTag("DatabaseError", (err) =>
                Effect.fail(
                    new UserNotFoundError({
                        userId: id,
                        message: "User not found",
                    }),
                )
            ),
        ),
)
```

### Annotating Spans

Add important context to spans, but keep the set small:

```typescript
// CORRECT, important business identifiers
yield* Effect.annotateCurrentSpan("userId", userId)
yield* Effect.annotateCurrentSpan("orderId", orderId)
yield* Effect.annotateCurrentSpan("amount", amount)

// WRONG, too much detail, noise in traces
yield* Effect.annotateCurrentSpan("userEmail", user.email)
yield* Effect.annotateCurrentSpan("userName", user.name)
yield* Effect.annotateCurrentSpan("userCreatedAt", user.createdAt)
yield* Effect.annotateCurrentSpan("step", "validating")
yield* Effect.annotateCurrentSpan("step", "processing")
yield* Effect.annotateCurrentSpan("step", "completing")
```

## Services Without `make` (Runtime Injected Infrastructure)

Omit `make` when the implementation is supplied by the runtime rather than constructed by your
code. The class is then a bare key.

### Cloudflare Worker Bindings

```typescript
import { Context, Effect } from "effect"

// These are provided by the runtime, not created by our code
export class KVNamespace extends Context.Service<
    KVNamespace,
    CloudflareKVNamespace
>()("KVNamespace") {}

export class R2Bucket extends Context.Service<
    R2Bucket,
    CloudflareR2Bucket
>()("R2Bucket") {}

// In the worker entry point
const handler = {
    fetch(request: Request, env: Env) {
        return program.pipe(
            Effect.provideService(KVNamespace, env.MY_KV),
            Effect.provideService(R2Bucket, env.MY_BUCKET),
            Effect.runPromise,
        )
    }
}
```

### Services With Default Values

When a service has a sensible default and callers rarely override it, use `Context.Reference`
for fiber local state. A reference never needs providing.

```typescript
import { Context, Effect } from "effect"

const RequestTimeout = Context.Reference<number>("RequestTimeout", {
    defaultValue: () => 30_000,
})

// Read it like any service, no layer required
const program = Effect.gen(function* () {
    const timeout = yield* RequestTimeout
})

// Override for a subtree
const withShortTimeout = Effect.provideService(program, RequestTimeout, 5_000)
```

Note the signature: `Context.Reference<Value>(id, options)` is a plain function call with
`defaultValue` in options.

### Database and Redis Clients (Infrastructure)

```typescript
// Infrastructure provided at app root
// Prefer @effect/sql or similar typed clients, their keys are already Context.Services

import { PgClient } from "@effect/sql-pg"

// Concrete config
const DatabaseLive = PgClient.layer({
    host: "localhost",
    port: 5432,
    database: "app",
})

// Config driven, with the layerConfig variant
const DatabaseFromConfig = PgClient.layerConfig({
    host: Config.String("DB_HOST"),
    port: Config.Int("DB_PORT"),
    database: Config.String("DB_NAME"),
})
```

`PgClient.layer` takes a concrete config; the `Config` wrapped form is
`PgClient.layerConfig`. `Config.Int` parses integers.

## Single Responsibility

Each service has a focused responsibility:

```typescript
// CORRECT, focused services
export class UserService extends Context.Service<UserService>()("UserService", { make: makeUserService }) {}
export class AuthService extends Context.Service<AuthService>()("AuthService", { make: makeAuthService }) {}
export class NotificationService extends Context.Service<NotificationService>()("NotificationService", { make: makeNotifications }) {}

// WRONG, god service doing everything
export class AppService extends Context.Service<AppService>()("AppService", {
    make: Effect.gen(function* () {
        return {
            createUser,
            deleteUser,
            login,
            logout,
            sendEmail,
            sendPush,
            processPayment,
            // ... 50 more methods
        }
    }),
}) {}
```

## Service Interface Patterns

### Return Types

> See also: [Using Impure Functions Directly in Business Logic] in `anti-patterns.md` for why raw `fetch()`, `Math.random()`, and similar need modeling as services

Services return `Effect` types, never `Promise`:

```typescript
// CORRECT
const findById = Effect.fn("UserService.findById")(
    function* (id: UserId): Effect.Effect<User, UserNotFoundError> {
        // ...
    }
)

// WRONG, Promise in service interface
const findById = async (id: UserId): Promise<User> => {
    // ...
}
```

### Use Option for Nullable Results

```typescript
// CORRECT, findById can fail, findByIdOption returns Option
const findById = Effect.fn("UserService.findById")(
    function* (id: UserId): Effect.Effect<User, UserNotFoundError> {
        const maybeUser = yield* repo.findById(id)
        return yield* Option.match(maybeUser, {
            onNone: () => Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" })),
            onSome: Effect.succeed,
        })
    }
)

const findByIdOption = Effect.fn("UserService.findByIdOption")(
    function* (id: UserId): Effect.Effect<Option.Option<User>> {
        return yield* repo.findById(id)
    }
)
```

## Testing Services

For a static double, `Layer.succeed` with `.of` for shape checking:

```typescript
export const UserServiceTest = Layer.succeed(
    UserService,
    UserService.of({
        findById: (id) => Effect.succeed(mockUser),
        create: (input) => Effect.succeed({ ...mockUser, ...input }),
    })
)
```

For a stateful mock, define a second layer on the real service class rather than a second class.
The context key must be the same one production code yields:

```typescript
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () { /* real implementation */ }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide(UserRepo.layer),
    )

    static readonly layerTest = Layer.effect(
        this,
        Effect.gen(function* () {
            const users = new Map<string, User>()

            const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
                const user = users.get(id)
                if (!user) return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" }))
                return user
            })

            const create = Effect.fn("UserService.create")(function* (input: CreateUserInput) {
                const user = { id: UserId.make(crypto.randomUUID()), ...input }
                users.set(user.id, user)
                return user
            })

            return { findById, create }
        }),
    )
}
```

See `layer-patterns.md` for composing these layers and `testing-patterns.md` for wiring them
into tests.
