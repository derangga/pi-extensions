# Testing Patterns

> Effect v4. Tests use `@effect/vitest`, with `it.effect` for Effect-returning tests and `assert`
> rather than Vitest's `expect`.

## Test Runner Basics

```typescript
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

describe("UserService", () => {
    // it.effect - for Effect-returning tests (the default choice)
    it.effect("creates a user", () =>
        Effect.gen(function* () {
            const users = yield* UserService
            const user = yield* users.create({ name: "Alice", email: "alice@example.com" })
            assert.strictEqual(user.name, "Alice")
        }).pipe(Effect.provide(TestLive))
    )

    // regular it - for pure synchronous tests
    it("formats a display name", () => {
        assert.strictEqual(formatName("Alice", "Smith"), "Alice Smith")
    })
})
```

Rules that come with this runner:

- **`it.effect` and `it.live` already provide and close a `Scope`** per test, so do not wrap test
  bodies in `Effect.scoped`.
- **Use `assert`, not `expect`.** `@effect/vitest` re-exports everything from Vitest, so the
  import is one line either way. `assert` is the convention.
- **Never `Effect.runSync` in tests.** Return the Effect from `it.effect` instead.
- Use `it.layer(SomeLayer)("suite name", (it) => ...)` to share a layer across a whole suite,
  built once rather than per test.

## Stateful Mocks

For stateful services (ones that persist data across calls within a test), define a
`layerTest` static on the real service class. Back it with an in-memory `Map` and wrap every
method with `Effect.fn`.

**Why a service layer rather than a bare object literal:**

1. **Same context slot.** The mock satisfies exactly the slot production code yields from.
2. **Tracing preserved.** `Effect.fn` wrappers keep span names in test runs, making slow or
   flaky tests debuggable.
3. **Typed errors.** The mock can surface the same `Schema.TaggedError` types as production.
4. **Isolation.** Each `Effect.provide(UserService.layerTest)` call builds a fresh `Map`.

### Correct Pattern

```typescript
import { Context, Effect, Layer, Schema } from "effect"

class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
    "UserNotFoundError",
    { userId: Schema.String, message: Schema.String },
) {}

interface User { id: string; name: string; email: string }

export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () { /* real implementation */ }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide(UserRepo.layer),
    )

    // In-memory test implementation on the same class
    static readonly layerTest = Layer.effect(
        this,
        Effect.gen(function* () {
            const store = new Map<string, User>()
            let counter = 1

            const findById = Effect.fn("UserService.findById")(function* (id: string) {
                const user = store.get(id)
                if (!user) {
                    return yield* Effect.fail(new UserNotFoundError({ userId: id, message: "Not found" }))
                }
                return user
            })

            const create = Effect.fn("UserService.create")(function* (input: Omit<User, "id">) {
                const user: User = { id: `user-${counter++}`, ...input }
                store.set(user.id, user)
                return user
            })

            return { findById, create }
        }),
    )
}

// In tests
it.effect("creates then finds a user", () =>
    Effect.gen(function* () {
        const users = yield* UserService
        const created = yield* users.create({ name: "Alice", email: "alice@example.com" })
        const found = yield* users.findById(created.id)
        assert.strictEqual(found.name, "Alice")
    }).pipe(Effect.provide(UserService.layerTest))
)
```

A separate mock class reusing the identifier string also works, because context lookup is by the
identifier, so `class UserServiceInMemory extends Context.Service<UserService>()("UserService", ...)`
lands in the same slot. Prefer `layerTest` anyway: the string match is an unchecked convention
that a typo breaks silently.

Tests must `yield* UserService` before calling methods, just like production code. There are no
accessor shortcuts.

### Wrong Pattern

```typescript
// WRONG: bare object literal, no tracing, no typed errors
const UserServiceTest = Layer.succeed(UserService, {
    findById: (id) => Effect.succeed({ id, name: "Test", email: "t@test.com" }),
    create: (input) => Effect.succeed({ id: "1", ...input }),
})
```

`Layer.succeed` with `Service.of(...)` is fine for a **static** stub with no state. See
`layer-patterns.md`. It is the wrong tool once the mock has to remember anything.

---

## Asserting on Tagged Errors with Exit/Cause

**Use `Effect.exit`** to capture failures as values. Never assert with `.rejects.toThrow()`. It
converts the error to a plain `Error`, discarding `_tag` and all context fields.

### Exit Inspection APIs

| API | Purpose |
| ----- | --------- |
| `Effect.exit(effect)` | Convert an Effect into one yielding `Exit<A, E>`, never failing |
| `Exit.isFailure(exit)` | `true` if the Exit is a failure |
| `Exit.isSuccess(exit)` | `true` if the Exit is a success |
| `exit.value` | Success value (valid after `Exit.isSuccess` check) |
| `exit.cause` | `Cause<E>` (valid after `Exit.isFailure` check) |
| `Cause.findErrorOption(cause)` | `Option<E>`, `Some(err)` for typed failures, `None` for defects |
| `error._tag` | Discriminant on `Schema.TaggedError` to identify error type |

The `Cause` structure is flattened. See `error-patterns.md`.

### Correct Pattern

```typescript
import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"

it.effect("fails with UserNotFoundError including userId context", () =>
    Effect.gen(function* () {
        const users = yield* UserService
        const exit = yield* Effect.exit(users.findById("missing-123"))

        assert.isTrue(Exit.isFailure(exit))
        if (!Exit.isFailure(exit)) return

        const maybeError = Cause.findErrorOption(exit.cause)
        assert.isTrue(Option.isSome(maybeError))
        if (!Option.isSome(maybeError)) return

        const error = maybeError.value
        assert.strictEqual(error._tag, "UserNotFoundError")
        assert.strictEqual(error.userId, "missing-123")
        assert.strictEqual(error.message, "User not found")
    }).pipe(Effect.provide(UserService.layerTest))
)
```

### Wrong Pattern

```typescript
// WRONG: loses _tag, userId, and all Schema.TaggedError context fields
it("fails when user not found", async () => {
    await expect(
        Effect.runPromise(program.pipe(Effect.provide(UserService.layerTest))),
    ).rejects.toThrow() // Only checks that *something* threw, not which error
})
```

---

## Shared TestLive Layer Composition

Compose all test service layers into a single exported `TestLive` in `test/setup.ts`. Every test
file imports this shared layer. Per-test overrides use `TestLive.pipe(Layer.provide(SpecialMock))`.

**Why a shared layer matters:**

1. **Single source of truth.** Adding a new mock requires one change in `setup.ts`, not a hunt
   through every file.
2. **Prevents drift.** Files cannot accidentally omit a service or use a stale mock.
3. **Layer memoization.** Shared infrastructure (for example in-memory DB) is instantiated once.
4. **Easy overrides.** One-line per-test overrides without rebuilding the full composition.

### Correct Pattern

```typescript
// test/setup.ts
import { Layer } from "effect"
import { UserService } from "../src/UserService"
import { OrderService } from "../src/OrderService"
import { ProductService } from "../src/ProductService"
import { InMemoryDatabaseLive } from "./mocks/InMemoryDatabaseLive"

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
    it.effect("creates a user", () =>
        Effect.gen(function* () {
            const users = yield* UserService
            const user = yield* users.create({ name: "Alice", email: "alice@example.com" })
            assert.strictEqual(user.email, "alice@example.com")
        }).pipe(Effect.provide(TestLive))
    )
})

// Per-test override
const OverrideLayer = TestLive.pipe(Layer.provide(AlwaysFailingUserService))
```

For a suite that shares one built layer across all its tests, use `it.layer`:

```typescript
it.layer(TestLive)("UserService", (it) => {
    it.effect("creates a user", () =>
        Effect.gen(function* () {
            const users = yield* UserService
            // ...
        })
    )
})
```

### Test Isolation and Memoization

Layers memoize across `Effect.provide` calls, which is the desired behavior in most tests.
One in-memory database is shared by every mock in `TestLive`. When a test needs genuinely
independent resources, opt out explicitly:

```typescript
// Fresh instance, bypassing the shared memo map
Effect.provide(Layer.fresh(InMemoryDatabaseLive))

// Entire subtree isolated with its own memo map
Effect.provide(TestLive, { local: true })
```

### Wrong Pattern

```typescript
// WRONG: layer composition duplicated (and diverged) in every test file

// test/user.test.ts
const TestLayer = Layer.mergeAll(
    UserService.layerTest,
    OrderService.layerTest,
    ProductService.layerTest,
).pipe(Layer.provide(InMemoryDatabaseLive))

// test/order.test.ts, ProductService accidentally omitted
const TestLayer = Layer.mergeAll(
    UserService.layerTest,
    OrderService.layerTest,
    // missing entry here, tests pass until a feature uses ProductService, then break
).pipe(Layer.provide(InMemoryDatabaseLive))
```

### TestLive Structure Guidelines

| Concern | Recommendation |
| --------- | ---------------- |
| File location | `test/setup.ts` or `test/layers.ts` |
| Export name | `TestLive` (matches `AppLive` convention) |
| Composition | `Layer.mergeAll(ServiceA.layerTest, ServiceB.layerTest, ...)` |
| Infrastructure | `.pipe(Layer.provide(InMemoryDatabaseLive))` |
| Per-test overrides | `TestLive.pipe(Layer.provide(SpecificMock))` |
| Per-suite sharing | `it.layer(TestLive)("suite", (it) => ...)` |

---

## Controlling Time with TestClock

**Never use `Date.now()` or `new Date()`** in business logic. Use `Clock`, and drive it with
`TestClock` in tests. `it.effect` provides the test services automatically, and the explicit
layer is `Layer.mergeAll(TestConsole.layer, TestClock.layer())`.

```typescript
import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

it.effect("retries three times over increasing delays", () =>
    Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(flakyOperation)

        // Advance virtual time rather than actually waiting
        yield* TestClock.adjust("1 seconds")
        yield* TestClock.adjust("2 seconds")

        const result = yield* Fiber.join(fiber)
        assert.strictEqual(result.attempts, 3)
    })
)
```

`Effect.forkChild` starts the background fiber and `Fiber.join` waits for its result. `Fiber`
is a handle, not an `Effect`, so always join explicitly.

---

## Abstracting Impure Functions as Services

**Never call `crypto.randomUUID()`, `Math.random()`, or `Date.now()` directly in business
logic.** Abstract them behind a `Context.Service` so tests can inject deterministic
implementations.

> See also: [Using Impure Functions Directly in Business Logic] in `anti-patterns.md`

### Common Impure Functions to Abstract

| Impure Call | Service Abstraction | Effect Built-in |
| ------------- | -------------------- | - |
| `crypto.randomUUID()` | `IdGenerator` service | none |
| `Math.random()` | `RandomNumber` service | none |
| `Date.now()` / `new Date()` | Use `Clock` directly | `Clock.currentTimeMillis` |
| `fetch(url)` | `HttpClient` service | `effect/unstable/http` `HttpClient` |

### Correct Pattern

```typescript
import { Context, Effect, Layer } from "effect"

// IdGenerator wraps crypto.randomUUID
export class IdGenerator extends Context.Service<IdGenerator>()("IdGenerator", {
    make: Effect.sync(() => ({
        generate: Effect.sync(() => crypto.randomUUID()),
    })),
}) {
    static readonly layer = Layer.effect(this, this.make)
}

// RandomNumber wraps Math.random
export class RandomNumber extends Context.Service<RandomNumber>()("RandomNumber", {
    make: Effect.sync(() => ({
        next: Effect.sync(() => Math.random()),
        nextInt: (min: number, max: number) =>
            Effect.sync(() => Math.floor(Math.random() * (max - min + 1)) + min),
    })),
}) {
    static readonly layer = Layer.effect(this, this.make)
}

// Business logic depends on services, not raw globals
export class UserService extends Context.Service<UserService>()("UserService", {
    make: Effect.gen(function* () {
        const idGen = yield* IdGenerator
        const rng = yield* RandomNumber

        const create = Effect.fn("UserService.create")(
            function* (input: { name: string; email: string }) {
                const id = yield* idGen.generate
                const code = yield* rng.nextInt(100_000, 999_999)
                return { id, inviteCode: String(code), ...input }
            },
        )

        return { create }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide([IdGenerator.layer, RandomNumber.layer]),
    )
}

// Deterministic test layers using factory functions with closure counters
const makeTestIdGenerator = (ids: string[]) => {
    let index = 0
    return Layer.succeed(IdGenerator, {
        generate: Effect.sync(() => {
            const id = ids[index % ids.length]
            index++
            return id
        }),
    })
}

const makeTestRandomNumber = (values: number[]) => {
    let index = 0
    return Layer.succeed(RandomNumber, {
        next: Effect.sync(() => { const v = values[index % values.length]; index++; return v }),
        nextInt: (_min: number, _max: number) =>
            Effect.sync(() => { const v = values[index % values.length]; index++; return v }),
    })
}

// Test: provide the deterministic layers underneath the service
it.effect("generates deterministic ids and invite codes", () =>
    Effect.gen(function* () {
        const users = yield* UserService
        const user = yield* users.create({ name: "Alice", email: "alice@example.com" })

        assert.strictEqual(user.id, "fixed-uuid-001")
        assert.strictEqual(user.inviteCode, "555555")
    }).pipe(
        Effect.provide(
            Layer.effect(UserService, UserService.make).pipe(
                Layer.provide([
                    makeTestIdGenerator(["fixed-uuid-001"]),
                    makeTestRandomNumber([555_555]),
                ]),
            ),
        ),
    )
)
```

Because `UserService.layer` bakes in the production `IdGenerator.layer` and `RandomNumber.layer`,
the test rebuilds the layer from `UserService.make` with test dependencies instead. The `make`
effect is exposed as a static, so each test can rewire it freely.

### Wrong Pattern

```typescript
// WRONG: impure calls directly in business logic
const createUser = (input: { name: string; email: string }) =>
    Effect.gen(function* () {
        const id = crypto.randomUUID()                              // Non-deterministic
        const code = Math.floor(Math.random() * 900_000) + 100_000 // Non-deterministic
        return { id, inviteCode: String(code), ...input }
    })

// Tests are forced to use fragile monkey-patching
vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-id" as any)
// Global spy leaks between tests, requires restoration, tightly couples to platform API
```

---

## Property-Based Testing with Schema Arbitraries

Schema arbitraries are native in Effect v4 and live in `effect/unstable/arbitrary`. Derive an
`Arbitrary` from any Schema with `Arbitrary.schema`, then run property checks with
`checkEffect` inside `it.effect`:

```typescript
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"

// Reuse your domain schemas, the Arbitrary follows every check and brand
const CreateUserInputArb = Arbitrary.schema(CreateUserInput)

it.effect("created users always round-trip their fields", () =>
    Arbitrary.checkEffect(CreateUserInputArb, (input) =>
        Effect.gen(function* () {
            const users = yield* UserService
            const created = yield* users.create(input)
            return created.email === input.email && created.name === input.name
        }).pipe(Effect.provide(UserService.layerTest))
    ).pipe(
        Effect.tap((result) => {
            const message = Arbitrary.formatCheckFailure(result)
            if (message) {
                // Fails the test with the shrunk counterexample
                return Effect.fail(new Error(message))
            }
            return Effect.void
        }),
        Effect.asVoid,
    )
)
```

Notes:

- `checkEffect` runs the property across generated inputs and shrinks the first falsification.
  `Arbitrary.formatCheckFailure(result)` returns `undefined` for a passed result and a
  diagnostic with the shrunk input otherwise. Check the `result._tag` directly when you need
  the `Passed | Falsified | Exhausted | ReplayMismatch` distinction.
- Properties must be deterministic per input and must not mutate generated values. Acquire any
  stateful fixture inside each evaluation rather than sharing it across runs.
- Use `Arbitrary.sampleEffect(arb, { count })` when you need a bounded batch of generated values
  as fixtures, for example fuzzing a decoder:

```typescript
const users = yield* Arbitrary.sampleEffect(UserArb, { count: 100 })
for (const user of users) {
    const encoded = yield* Schema.encodeEffect(User)(user)
    assert.deepStrictEqual(yield* Schema.decodeUnknownEffect(User)(encoded), user)
}
```

`effect/unstable/arbitrary` is an unstable module, so pin your Effect version when you depend
on it. See `v4-semantics.md`.
