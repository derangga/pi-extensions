---
name: effect-best-practices
description: Enforces Effect v4 patterns for services, errors, layers, atoms, streams, SQL, and transactional state. Use when writing code with Context.Service, Schema.TaggedError, Layer composition, Stream, @effect/sql, or @effect/atom React components.
version: 2.1.0
---

# Effect-TS Best Practices

This skill enforces opinionated, consistent patterns for Effect-TS codebases. These patterns optimize for type safety, testability, observability, and maintainability.

## Version: Effect v4

This skill targets **Effect v4** (`4.0.0-rc.113` at time of writing). Install from the `rc` tag:

```bash
pnpm add effect@rc
```

Two facts that shape everything below:

- **Package layout.** HTTP, RPC, cluster, workflow, and related modules live in core `effect` under `effect/unstable/*`. Separate packages: `@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`, `@effect/atom-*`, `@effect/opentelemetry`, `@effect/vitest`.
- **Single version number.** Every `effect` / `@effect/*` package shares one version. If you use `effect@4.0.0-rc.113`, use the same version for `@effect/sql-pg`.

See `references/v4-semantics.md` for core semantics (what can be yielded, structural equality, fiber keep-alive, unstable-module policy).

## Effect Language Server (Required)

**The Effect Language Server is essential for Effect development.** It catches errors at edit-time that TypeScript alone cannot detect, provides Effect-specific refactors, and improves developer productivity.

### Setup

1. Install:

```bash
npm install @effect/tsgo --save-dev
```

1. Add to `tsconfig.json`. The plugin name stays `@effect/language-service` even though the
   installed package is `@effect/tsgo`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

1. Configure your editor to use workspace TypeScript:
   - **VSCode**: F1 → "TypeScript: Select TypeScript Version" → "Use Workspace Version"
   - **JetBrains**: Settings → Languages & Frameworks → TypeScript → Use workspace version

### Features

- **Diagnostics**: Detects 30+ Effect-specific issues (floating Effects, missing requirements, incorrect yield patterns)
- **Quick Info**: Hover to see Effect type parameters (Success, Error, Requirements)
- **Completions**: Auto-complete `Self`, Duration strings, Schema brands
- **Refactors**: Convert async → Effect.gen, auto-compose Layers, transform to Schema

### Build-Time Diagnostics

For CI enforcement:

```bash
npx effect-tsgo patch
```

See `references/language-server.md` for configuration options and CLI tools.

## Quick Reference: Critical Rules

| Category            | DO                                                      | DON'T                                            |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Services            | `Context.Service` with `make`                           | Defining services without `Context.Service`      |
| Service Access      | `yield* UserService` in a gen                           | `Service.use` when `yield*` will do              |
| Dependencies        | `static layer` wires deps via `Layer.provide`           | Leaving requirements in the layer's `R`          |
| Layer Naming        | `Service.layer` / `layerTest` / `layerConfig`           | Generic `Default` / `Live` layer names           |
| Layers              | `Layer.mergeAll` for flat composition                   | Deeply nested `Layer.provide` chains             |
| Layer Chaining      | `Layer.provideMerge` for incremental composition        | Multiple `Layer.provide` (creates nested types)  |
| Errors              | `Schema.TaggedError` with `message` field               | Plain classes or generic Error                   |
| Error Specificity   | `UserNotFoundError`, `SessionExpiredError`              | Generic `NotFoundError`, `BadRequestError`       |
| Error Handling      | `catchTag`/`catchTags`                                  | `Effect.catch` blanket handler or `mapError`     |
| IDs                 | `Schema.String.check(Schema.isUUID())` + `Schema.brand` | Plain `string` for entity IDs                    |
| Functions           | `Effect.fn("Service.method")`                           | Anonymous generators                             |
| Happy Path          | gen body is the call graph, error transform is the E    | `catchTag`/`retry` inlined in the gen body       |
| Error Scoping       | Each layer maps what it received to its own error       | Leaking `SqlError` past the service that made it |
| Logging             | `Effect.log` with structured data                       | `console.log`                                    |
| Config              | `Config.*` with schema checks                           | `process.env` directly                           |
| Options             | `Option.match` with both cases                          | `Option.getOrThrow`                              |
| Nullability         | `Option<T>` in domain types                             | `null`/`undefined`                               |
| Yielding            | `yield* Ref.get(ref)` / `Deferred.await(d)`             | Yielding `Ref`, `Deferred`, `Fiber`, `Option`    |
| Atoms               | `Atom.make` outside components                          | Creating atoms inside render                     |
| Atom State          | `Atom.keepAlive` for global state                       | Forgetting keepAlive for persistent state        |
| Atom Updates        | `useAtomSet` in React components                        | `Atom.update` imperatively from React            |
| Atom Cleanup        | `get.addFinalizer()` for side effects                   | Missing cleanup for event listeners              |
| Atom Results        | `AsyncResult.match` / `matchWithError`                  | Ignoring loading/error states                    |
| Concurrency         | `Effect.all` with `{ concurrency }`                     | `Promise.all` with Effect results                |
| Background Work     | `Effect.forkChild` + other work + `Fiber.join`          | `Effect.forkChild` + immediate `Fiber.join`      |
| Shared State        | `Ref.make` / `Ref.update`                               | `let` variables mutated in Effects               |
| Resources           | `Effect.acquireRelease` + `Effect.scoped`               | `try/finally` for cleanup                        |
| Resource Layers     | `Layer.effect` for scoped resources                     | Global mutable singletons                        |
| HTTP Endpoints      | `HttpApiEndpoint` + `HttpApiGroup` + `HttpApiBuilder`   | Manual URL parsing / JSON serialization          |
| HTTP Errors         | `error:` on the endpoint + `{ httpApiStatus: n }`       | Manual `catchTag` in every handler               |
| HTTP Auth           | `HttpApiSecurity.bearer` + middleware                   | Manual header parsing per route                  |
| HTTP Client         | `HttpApiClient.make(AppApi)` derived from the contract  | Hand-rolled `fetch` / manual URL + JSON wrappers |
| Client Interceptors | `HttpClient.transformResponse` / `transformClient`      | Ad-hoc retry/refresh logic per call site         |

## Service Definition Pattern

**Always use `Context.Service`** for business logic services.

```typescript
import { Context, Effect, Layer, Option } from 'effect'

export class UserService extends Context.Service<UserService>()('UserService', {
  make: Effect.gen(function* () {
    const repo = yield* UserRepo
    const cache = yield* CacheService

    const findById = Effect.fn('UserService.findById')(function* (id: UserId) {
      const cached = yield* cache.get(id)
      if (Option.isSome(cached)) return cached.value

      const user = yield* repo.findById(id)
      yield* cache.set(id, user)
      return user
    })

    const create = Effect.fn('UserService.create')(function* (data: CreateUserInput) {
      const user = yield* repo.create(data)
      yield* Effect.log('User created', { userId: user.id })
      return user
    })

    return { findById, create }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([UserRepo.layer, CacheService.layer])
  )
}

// Usage - yield the service, then call its methods
const program = Effect.gen(function* () {
  const users = yield* UserService
  return yield* users.findById(userId)
})

// At app root
const MainLive = Layer.mergeAll(UserService.layer, OtherService.layer)
```

A service defines `make` for construction and `static layer` for wiring. Wire dependencies with `Layer.provide` inside the service layer so the requirements channel stays empty at the app root.

**Services without `make`** are bare context keys. Use them for infrastructure injected at runtime (Cloudflare KV, worker bindings) and provide with `Effect.provideService`.

See `references/service-patterns.md` for detailed patterns.

## Error Definition Pattern

**Always use `Schema.TaggedError`** for errors. This makes them serializable (required for RPC) and provides consistent structure.

```typescript
import { Schema } from 'effect'
import { HttpApiSchema } from 'effect/unstable/httpapi'

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  'UserNotFoundError',
  {
    userId: UserId,
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class UserCreateError extends Schema.TaggedError<UserCreateError>()('UserCreateError', {
  message: Schema.String,
  cause: Schema.optional(Schema.String),
}, { httpApiStatus: 400 }) {}
```

Status is the third argument, the annotations object. `HttpApiSchema.status(404)` writes the same
annotation through `.pipe`, but only on plain schema values such as
`User.pipe(HttpApiSchema.status(201))`. Piping it in a class heritage clause makes the class
reference itself in its own base expression and fails to compile.

**Error handling with `catchTag` and `catchTags`:**

```typescript
// CORRECT - preserves type information
yield *
  repo.findById(id).pipe(
    Effect.catchTag('DatabaseError', (err) =>
      Effect.fail(new UserNotFoundError({ userId: id, message: 'Lookup failed' }))
    ),
    Effect.catchTag('ConnectionError', (err) =>
      Effect.fail(new ServiceUnavailableError({ message: 'Database unreachable' }))
    )
  )

// CORRECT - multiple tags at once
yield *
  effect.pipe(
    Effect.catchTags({
      DatabaseError: (err) =>
        Effect.fail(new UserNotFoundError({ userId: id, message: err.message })),
      ValidationError: (err) =>
        Effect.fail(new InvalidEmailError({ email: input.email, message: err.message })),
    })
  )
```

Avoid blanket `Effect.catch`. It discards type information.

### Prefer Explicit Over Generic Errors

**Every distinct failure reason deserves its own error type.** Don't collapse multiple failure modes into generic HTTP errors.

```typescript
// WRONG - Generic errors lose information
export class NotFoundError extends Schema.TaggedError<NotFoundError>()('NotFoundError', {
  message: Schema.String,
}, { httpApiStatus: 404 }) {}

// Then mapping everything to it:
Effect.catchTags({
  UserNotFoundError: (err) => Effect.fail(new NotFoundError({ message: 'Not found' })),
  ChannelNotFoundError: (err) => Effect.fail(new NotFoundError({ message: 'Not found' })),
  MessageNotFoundError: (err) => Effect.fail(new NotFoundError({ message: 'Not found' })),
})
// Frontend gets useless: { _tag: "NotFoundError", message: "Not found" }
// Which resource? User? Channel? Message? Can't tell!
```

```typescript
// CORRECT - Explicit domain errors with rich context
export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  'UserNotFoundError',
  { userId: UserId, message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class ChannelNotFoundError extends Schema.TaggedError<ChannelNotFoundError>()(
  'ChannelNotFoundError',
  { channelId: ChannelId, message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()(
  'SessionExpiredError',
  { sessionId: SessionId, expiredAt: Schema.DateTimeUtcFromString, message: Schema.String },
  { httpApiStatus: 401 }
) {}

// Frontend can show specific UI:
// - UserNotFoundError → "User doesn't exist"
// - ChannelNotFoundError → "Channel was deleted"
// - SessionExpiredError → "Your session expired. Please log in again."
```

See `references/error-patterns.md` for error remapping, retry patterns, and the flattened `Cause`.

## Schema & Branded Types Pattern

**Brand all entity IDs** for type safety across service boundaries. String refinements are **checks** on base schemas:

```typescript
import { Schema } from 'effect'

// Entity IDs - always branded
export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('@App/UserId'))
export type UserId = Schema.Schema.Type<typeof UserId>

export const OrganizationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('@App/OrganizationId')
)
export type OrganizationId = Schema.Schema.Type<typeof OrganizationId>

// Domain types - use Schema.Struct
export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.String,
  organizationId: OrganizationId,
  createdAt: Schema.DateTimeUtcFromString,
})
export type User = Schema.Schema.Type<typeof User>

// Input types for mutations
export const CreateUserInput = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  name: Schema.String.check(Schema.isMinLength(1)),
  organizationId: OrganizationId,
})
export type CreateUserInput = Schema.Schema.Type<typeof CreateUserInput>
```

The examples above use `Schema.String.check` with `Schema.isUUID`, `Schema.isPattern`, and `Schema.isMinLength`, plus `Schema.DateTimeUtcFromString` for timestamps. `Schema.brand`, `Schema.Struct`, and `Schema.Schema.Type` define branded IDs and object shapes.

**When NOT to brand:**

- Simple strings that don't cross service boundaries (URLs, file paths)
- Primitive config values

See `references/schema-patterns.md` for transforms and advanced patterns.

## Function Pattern with Effect.fn

**Always use `Effect.fn`** for service methods. This provides automatic tracing with proper span names:

```typescript
// CORRECT - Effect.fn with descriptive name
const findById = Effect.fn('UserService.findById')(function* (id: UserId) {
  yield* Effect.annotateCurrentSpan('userId', id)
  const user = yield* repo.findById(id)
  return user
})

// CORRECT - Effect.fn with multiple parameters
const transfer = Effect.fn('AccountService.transfer')(function* (
  fromId: AccountId,
  toId: AccountId,
  amount: number
) {
  yield* Effect.annotateCurrentSpan('fromId', fromId)
  yield* Effect.annotateCurrentSpan('toId', toId)
  yield* Effect.annotateCurrentSpan('amount', amount)
  // ...
})
```

Use `Effect.fnUntraced` for hot paths, or for functions that only wrap an `Effect.gen` and don't need their own span.

### The gen body is A, the pipe is E

The gen body is the call graph: every `yield*` is an A flowing through it. Error handling lives in the transform after the generator, which enumerates every E the body can produce:

```typescript
const insert = Effect.fn('TweetRepo.insert')(
  // A - the graph, and nothing else
  function* (input: NewTweet) {
    const rows = yield* sql`insert into tweets ${sql.insert(input)} returning *`
    return yield* Schema.decodeUnknownEffect(Tweet)(rows[0])
  },
  // E - the complete enumeration
  (effect, input) =>
    effect.pipe(
      Effect.retry({ times: 2, schedule: Schedule.exponential('100 millis') }),
      Effect.catchTag(
        'SqlError',
        (e) => new PersistenceError({ op: 'TweetRepo.insert', cause: e.message })
      ),
      // a decode failure here is our bug, not the caller's problem
      Effect.catchTag('SchemaError', (e) => Effect.die(e))
    )
)
```

Read the actual E type of every yielded effect before writing the transform. The pipe is a complete enumeration, not a guess.

**Scope E per layer.** Each layer catches what it received and produces its own error: a service turns `SqlError` into `PersistenceError`, a handler turns `PersistenceError` into a response. Consumers stay ignorant of errors from three layers down.

**Divergent strategies** are the one case for handling errors inside the gen body: two yields needing different failure semantics, one failing hard while the other falls back, where the outer transform cannot tell which yield failed. Handle that single effect inline and mark it:

```typescript
yield *
  timeline.enqueueFanout(tweet.id).pipe(
    Effect.catchTag('QueueUnavailable', () =>
      // escape hatch: the tweet exists; timelines can be built on read
      Effect.logWarning('fanout deferred to lazy pull')
    )
  )
```

## Layer Composition

**Wire dependencies in the service's own layer**, not at usage sites:

```typescript
// CORRECT - the layer satisfies everything make requires
export class OrderService extends Context.Service<OrderService>()('OrderService', {
  make: Effect.gen(function* () {
    const users = yield* UserService
    const products = yield* ProductService
    const payments = yield* PaymentService
    // ...
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([UserService.layer, ProductService.layer, PaymentService.layer])
  )
  //  ^? Layer<OrderService, E, never>
}

// At app root - simple merge
const AppLive = Layer.mergeAll(
  OrderService.layer,
  // Infrastructure layers (intentionally left in the requirements above)
  DatabaseLive,
  RedisLive
)
```

**Layer composition patterns:**

```typescript
// Use Layer.mergeAll for flat composition of same-level layers
const RepoLive = Layer.mergeAll(UserRepo.layer, OrderRepo.layer, ProductRepo.layer)

// Use Layer.provideMerge for incremental chaining (flatter types than Layer.provide)
const MainLive = DatabaseLive.pipe(
  Layer.provideMerge(ConfigServiceLive),
  Layer.provideMerge(LoggerLive),
  Layer.provideMerge(CacheLive)
)
```

**Why compose layers rather than stacking `Effect.provide` calls:**

- **A visible dependency graph**: one composed layer shows the whole structure in one place.
- **TypeScript performance**: deep `Layer.provide` nesting creates complex recursive types that slow the LSP. `Layer.mergeAll` and `Layer.provideMerge` produce flatter types.
- **Resource management**: scoped layers properly share and clean up resources.

Layers share memoization across `Effect.provide` calls. Overlapping layers reuse the same instance. Composition is the recommendation. The shared memo map is a safety net, not a substitute. Opt out with `Layer.fresh` or `Effect.provide(layer, { local: true })` for a separate instance.

See `references/layer-patterns.md` for testing layers, config-dependent layers, and the `layerConfig` pattern.

## Option Handling

**Never use `Option.getOrThrow`**. Always handle both cases explicitly:

```typescript
// CORRECT - explicit handling
yield *
  Option.match(maybeUser, {
    onNone: () => Effect.fail(new UserNotFoundError({ userId, message: 'Not found' })),
    onSome: (user) => Effect.succeed(user),
  })

// CORRECT - with getOrElse for defaults
const name = Option.getOrElse(maybeName, () => 'Anonymous')

// CORRECT - Option.map for transformations
const upperName = Option.map(maybeName, (n) => n.toUpperCase())
```

`Option` is not an `Effect` subtype, so `yield* Option.some(1)` does not compile. Convert it with `Effect.fromOption`, which fails with `NoSuchElementError`. See `references/v4-semantics.md`.

## Effect Atom (Frontend State)

Effect Atom provides reactive state management for React with Effect integration. The React package is `@effect/atom-react`, and `Atom` lives in core Effect under `effect/unstable/reactivity`.

### Basic Atoms

```typescript
import { Atom } from 'effect/unstable/reactivity'

// Define atoms OUTSIDE components
const countAtom = Atom.make(0)

// Use keepAlive for global state that should persist
const userPrefsAtom = Atom.make({ theme: 'dark' }).pipe(Atom.keepAlive)

// Atom families for per-entity state
const modalAtomFamily = Atom.family((type: string) =>
  Atom.make({ isOpen: false }).pipe(Atom.keepAlive)
)
```

### React Integration

```tsx
import { useAtomValue, useAtomSet, useAtom, useAtomMount } from "@effect/atom-react"

function Counter() {
    const count = useAtomValue(countAtom)           // Read only
    const setCount = useAtomSet(countAtom)          // Write only
    const [value, setValue] = useAtom(countAtom)    // Read + write

    return <button onClick={() => setCount((c) => c + 1)}>{count}</button>
}

// Mount side-effect atoms without reading value
function App() {
    useAtomMount(keyboardShortcutsAtom)
    return <>{children}</>
}
```

### Handling Results with AsyncResult

Use `AsyncResult` for async atom states. Use `AsyncResult.match` for the three states, or `matchWithError` when you need typed errors separated from defects:

```tsx
import { AsyncResult } from "effect/unstable/reactivity"

function UserProfile() {
    const userResult = useAtomValue(userAtom) // AsyncResult<User, UserNotFoundError>

    return AsyncResult.matchWithError(userResult, {
        onInitial: () => <div>Loading...</div>,
        onError: (error) =>
            error._tag === "UserNotFoundError"
                ? <div>User not found</div>
                : <div>Error: {error.message}</div>,
        onDefect: (defect) => <div>Unexpected error</div>,
        onSuccess: (result) => <div>Hello, {result.value.name}</div>,
    })
}
```

For tag based branching, use an explicit `_tag` check (or a `switch`) inside `onError`.

### Atoms with Side Effects

```typescript
const scrollYAtom = Atom.make((get) => {
  const onScroll = () => get.setSelf(window.scrollY)

  window.addEventListener('scroll', onScroll)
  get.addFinalizer(() => window.removeEventListener('scroll', onScroll)) // REQUIRED

  return window.scrollY
}).pipe(Atom.keepAlive)
```

### React Mutations

For mutation atoms, derive loading state from `result.waiting` instead of `useState`:

```typescript
const [result, mutate] = useAtom(deleteMutation, { mode: 'promise' })
const isLoading = result.waiting // Updates automatically, no useState/finally needed
```

**Dialog ownership:** Move mutation logic into dialog components. Dialog owns the mutation hook, loading state, and toasts. Parent provides data props and an `onSuccess` callback.

**Cache invalidation:** Build an `Atom.runtime(layer)`, declare the mutation with `runtime.fn(fn, { reactivityKeys })` and the query with `runtime.atom(Reactivity.stream(effect, keys))`. Matching keys re-run the query after the mutation, replacing manual `refresh()` calls. `Atom.make` has no `reactivityKeys` option.

See `references/effect-atom-patterns.md` for complete patterns including families, localStorage, mutations, and anti-patterns.

## RPC & Cluster Patterns

For RPC contracts and cluster workflows, see:

- `references/rpc-cluster-patterns.md` - RpcGroup, Workflow.make, Activity patterns

The modules are `effect/unstable/rpc`, `effect/unstable/cluster`, `effect/unstable/workflow`.

## Concurrency

**Use `Effect.all` with `{ concurrency }`** for parallel execution. Use `Effect.forkChild` for background work:

```typescript
import { Effect, Fiber, Queue } from 'effect'

// Parallel execution with bounded concurrency
const results = yield * Effect.all(tasks, { concurrency: 5 })

// Background work with forkChild
const program = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(backgroundTask)
  const mainResult = yield* doMainWork()
  const bgResult = yield* Fiber.join(fiber)
  return { mainResult, bgResult }
})

// Producer/consumer with Queue
const queue = yield * Queue.bounded<Job>(100)
yield *
  Effect.forkChild(
    Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(queue)
        yield* processJob(job)
      })
    )
  )
```

Fork variants are `Effect.forkChild`, `Effect.forkDetach`, `Effect.forkScoped`, and `Effect.forkIn`. All four take `{ startImmediately, uninterruptible }` options. `Fiber` is not an Effect, so always use `Fiber.join(fiber)`, never `yield* fiber`.

See `references/concurrency-patterns.md` for Fork/Fiber variants, Queue, PubSub, Semaphore, Deferred, Latch, and polling patterns.

## Resource Management

**Use `Effect.acquireRelease`** for resources that need cleanup. Release is guaranteed on success, failure, and interruption:

```typescript
import { Effect } from 'effect'

const managedConnection = Effect.acquireRelease(
  connectToDatabase(), // acquire
  (conn) => conn.close().pipe(Effect.orDie) // release (guaranteed)
)

// Use with Effect.scoped
const result =
  yield *
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* managedConnection
      return yield* conn.query('SELECT * FROM users')
    })
  )
```

For scoped layers, `Layer.effect` supplies and excludes the layer's `Scope` automatically.

See `references/resource-patterns.md` for resource hierarchies, pooling, ManagedRuntime, and scoped layers.

## HTTP API

**Use `HttpApiEndpoint` + `HttpApiGroup` + `HttpApiBuilder`** for type-safe HTTP APIs. The modules live in `effect/unstable/httpapi`, and endpoints are declared with an options object:

```typescript
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

// Define the API. .add is a method on the group and api values
const MyApi = HttpApi.make('MyApi').add(
  HttpApiGroup.make('users').add(
    HttpApiEndpoint.get('getUser', '/users/:id', {
      params: Schema.Struct({ id: UserId }),
      success: User,
      error: UserNotFoundError, // status comes from the error's httpApiStatus annotation
    })
  )
)

// Implement handlers
const UsersApiLive = HttpApiBuilder.group(MyApi, 'users', (handlers) =>
  handlers.handle('getUser', ({ params }) =>
    Effect.gen(function* () {
      const users = yield* UserService
      return yield* users.findById(params.id)
    })
  )
)
```

`HttpApiEndpoint.get(id, path, options)` declares method, path, and schemas. `HttpApiBuilder.layer` serves the API, `HttpApiBuilder.endpoint` defines a single handler, CORS uses `HttpRouter.cors`, and errors are declared per endpoint.

On the client side, derive a fully-typed client from the same `HttpApi` with `HttpApiClient.make(MyApi)`. Every endpoint, payload, success, and typed error comes from the contract, so no manual URL strings or JSON wrappers:

```typescript
import { HttpApiClient } from 'effect/unstable/httpapi'

const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(MyApi, { baseUrl: 'http://localhost:3000' })
  const user = yield* client.users.getUser({ params: { id: userId } })
  // ^? typed error union (e.g. UserNotFoundError) on the Effect error channel
})
```

See `references/http-api-patterns.md` for middleware, authentication, CORS, rate limiting, OpenAPI/Swagger setup, and the full **Deriving an HTTP Client** section (base URL, `transformClient` interceptors, auth-refresh, typed error extraction, Promise bridging).

## Anti-Patterns (Forbidden)

These patterns are **never acceptable**:

```typescript
// FORBIDDEN - runSync/runPromise inside services
const result = Effect.runSync(someEffect) // Never do this

// FORBIDDEN - throw inside Effect.gen
yield* Effect.gen(function* () {
    if (bad) throw new Error("No!") // Use Effect.fail instead
})

// FORBIDDEN - Effect.catch blanket handler losing type info
yield* effect.pipe(Effect.catch(() => Effect.fail(new GenericError())))

// FORBIDDEN - yielding Ref, Deferred, Fiber directly
const value = yield* ref       // Use Ref.get(ref)
const done = yield* deferred   // Use Deferred.await(deferred)
const out = yield* fiber       // Use Fiber.join(fiber)

// FORBIDDEN - console.log
console.log("debug") // Use Effect.log

// FORBIDDEN - process.env directly
const key = process.env.API_KEY // Use Config.Redacted("API_KEY")

// FORBIDDEN - null/undefined in domain types
type User = { name: string | null } // Use Option<string>

// FORBIDDEN - deeply nested flatMap/andThen chains
step1().pipe(Effect.flatMap((a) => step2(a).pipe(Effect.flatMap(...)))) // Use Effect.gen

// FORBIDDEN - manual try/finally for resource cleanup
try { yield* use(res) } finally { yield* cleanup(res) } // Use Effect.acquireRelease + Effect.scoped

// FORBIDDEN - manual retry loops
for (let i = 0; i < 3; i++) { try { ... } catch { ... } } // Use Effect.retry + Schedule

// FORBIDDEN - prop-drilling dependencies through function args
const fn = (db: DB, logger: Logger, mailer: Mailer) => ... // Use Context.Service + Layer
```

See `references/anti-patterns.md` for the complete list with rationale.

## Observability

```typescript
// Structured logging
yield * Effect.log('Processing order', { orderId, userId, amount })

// Metrics
const orderCounter = Metric.counter('orders_processed')
yield * Metric.update(orderCounter, 1)

// Config with schema-based validation
const config = Config.all({
  port: Config.Int('PORT').pipe(Config.withDefault(3000)),
  apiKey: Config.Redacted('API_KEY'),
  maxRetries: Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    'MAX_RETRIES'
  ),
})
```

The examples above use `Metric.update(counter, 1)`, `Config.Int`, and `Config.schema` with a Schema check.

See `references/observability-patterns.md` for metrics and tracing patterns.

## Reference Files

For detailed patterns, consult these reference files in the `references/` directory:

- `v4-semantics.md` - what can be yielded, structural equality, fiber keep-alive, unstable-module policy
- `language-server.md` - Effect Language Service setup, diagnostics, refactors, CLI tools
- `service-patterns.md` - Context.Service, Effect.fn, services without `make`, Context.Reference
- `error-patterns.md` - Schema.TaggedError, error remapping, retry patterns, flattened Cause
- `schema-patterns.md` - Branded types, checks, transforms, Schema.Class
- `layer-patterns.md` - Dependency composition, memoization, testing layers
- `testing-patterns.md` - @effect/vitest, stateful mocks, Exit/Cause assertions, TestClock
- `rpc-cluster-patterns.md` - RpcGroup, Workflow, Activity patterns
- `effect-atom-patterns.md` - Atom, families, React hooks, AsyncResult handling
- `concurrency-patterns.md` - Fork/Fiber, parallel execution, Queue, PubSub, Semaphore, Deferred, Latch, and polling patterns
- `streams-patterns.md` - Stream sources, transformations, merging, buffers, Sinks, scoped bridges
- `sql-patterns.md` - SQL providers, tagged template statements, SqlSchema, SqlResolver, Migrator
- `stm-patterns.md` - Effect.tx, TxRef, TxHashMap, TxQueue, transactional patterns
- `resource-patterns.md` - acquireRelease, scoped, resource hierarchies, pooling, ManagedRuntime
- `http-api-patterns.md` - HttpApi, endpoints, middleware, auth, CORS, rate limiting, OpenAPI
- `anti-patterns.md` - Complete list of forbidden patterns
- `observability-patterns.md` - Logging, metrics, config patterns
