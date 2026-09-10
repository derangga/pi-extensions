# SQL Patterns

> Effect v4. SQL clients live in provider packages, and the shared interfaces live in
> `effect/unstable/sql`. The provider packages are `@effect/sql-clickhouse`, `@effect/sql-d1`,
> `@effect/sql-libsql`, `@effect/sql-mssql`, `@effect/sql-mysql2`, `@effect/sql-pg`,
> `@effect/sql-pglite`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-do`,
> `@effect/sql-sqlite-node`, `@effect/sql-sqlite-react-native`, and `@effect/sql-sqlite-wasm`.
> The core module `effect/unstable/sql` exports `Migrator`, `SqlClient`, `SqlConnection`,
> `SqlError`, `SqlModel`, `SqlResolver`, `SqlSchema`, `SqlStream`, and `Statement`.

## Provider Packages and the Core Interface

Every provider package exports a client service tag, a client layer, and an optional
provider specific migrator. The examples below use PostgreSQL, which is the most common
setup. The same shapes apply to the other providers, with their own config fields.

```typescript
import { PgClient } from "@effect/sql-pg"

// PgClient.PgClient is the context key for the concrete pg client
// PgClient.layer and PgClient.layerConfig build it
```

Provider layers provide two context keys at once: the concrete tag such as `PgClient.PgClient`,
and the generic `SqlClient.SqlClient` tag from `effect/unstable/sql`. Repos can depend on
either key, depending on whether they want to be provider specific or portable.

## Client Basics

The client value is callable. A tagged template becomes a `Statement`, and calling the
client with a plain string returns an escaped identifier:

```typescript
import { Context, Effect } from "effect"
import { PgClient } from "@effect/sql-pg"

export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
    make: Effect.gen(function* () {
        const sql = yield* PgClient.PgClient

        const findById = Effect.fn("UserRepo.findById")(function* (id: number) {
            // The statement is itself an Effect that resolves to ReadonlyArray of rows
            const rows = yield* sql`SELECT * FROM users WHERE id = ${id}`
            // Rows come back as `Row`, so a direct `as UserRow` does not overlap.
            // Decode with SqlSchema instead, shown below, when the shape matters
            return rows[0] as unknown as UserRow | undefined
        })

        // sql("name") is an escaped identifier, not a bound parameter
        const selectNames = Effect.fn("UserRepo.selectNames")(function* () {
            return yield* sql`SELECT ${sql("name")} FROM ${sql("users")}`
        })

        return { findById, selectNames }
    }),
}) {}
```

Three facts about the tagged template:

1. Interpolated values become bound parameters, never string splices.
2. Interpolated fragments, identifiers, and helpers are inlined structurally.
3. Executing a statement returns `Effect.Effect<ReadonlyArray<Row>, SqlError>`.

### Client-Level Helpers

The callable client carries helpers as properties:

| Property | Purpose |
| --- | --- |
| `sql.unsafe(raw, params?)` | raw string with explicit bound params |
| `sql.literal(raw)` | inline a literal SQL fragment |
| `sql.in(values)` | array helper, compiles to a placeholder group |
| `sql.in(column, values)` | `column IN (...)` fragment, `1=0` for an empty list |
| `sql.insert(rows)` | insert helper for one or many records |
| `sql.update(record, omit?)` | `SET` assignments for a single row |
| `sql.updateValues(rows, alias)` | multi row update, not supported in sqlite |
| `sql.and(clauses)` | `AND` chain, `1=1` when empty |
| `sql.or(clauses)` | `OR` chain, `1=1` when empty |
| `sql.csv(values)` | comma separated fragment, useful after `ORDER BY` |
| `sql.join(sep, parens?, fallback?)` | custom separator builder |
| `sql.onDialect({ sqlite, pg, mysql, mssql, clickhouse })` | branch per dialect |
| `sql.onDialectOrElse({ orElse, pg?, ... })` | branch with a fallback |
| `sql.withoutTransforms()` | a copy of the client that skips row transforms |
| `sql.safe` | copy of the client for external linters such as safeql |

## Statement Combinators

A `Statement<A>` is a `Fragment`, an `Effect<ReadonlyArray<A>, SqlError>`, and a set of
derived execution modes:

```typescript
const stmt = sql`SELECT * FROM users WHERE active = ${true}`

await stmt                          // Effect<ReadonlyArray<Row>, SqlError>, default transform
stmt.unprepared                     // skips the prepared statement path
stmt.withoutTransform               // skips row name and value transforms
stmt.raw                            // Effect<unknown, SqlError>, driver specific result
stmt.values                         // Effect<ReadonlyArray<ReadonlyArray<unknown>>>
stmt.valuesUnprepared               // values, unprepared
stmt.stream                         // Stream<Row, SqlError>, incremental rows
stmt.compile(true)                  // tuple of [sql, params], for tests or logging
```

There is no `.one` or `.firstRow` property on a statement. Typed row selection goes through
`SqlSchema.findOne` and `SqlSchema.findOneOption`, shown below.

## Parameterized Statements

Ordinary interpolation always binds. Build dynamic clauses from fragments, identifiers,
and the array helpers:

```typescript
import { Statement } from "effect/unstable/sql"

const findActive = (statuses: ReadonlyArray<string>) =>
    sql`SELECT * FROM ${sql("users")}
        WHERE ${sql.in("status", statuses)}
          AND ${sql.and([
              sql`verified_at IS NOT NULL`,
              sql`deleted_at IS NULL`,
          ])}`

// For bulk inserts, interpolate the insert helper and compose returning
const insertAll = (rows: ReadonlyArray<NewUser>) =>
    sql`INSERT INTO ${sql("users")} ${sql.insert(rows).returning("*")}`

// For updates, pass columns to omit, such as the primary key
const updateUser = (id: number, patch: UserPatch) =>
    sql`UPDATE ${sql("users")} SET ${sql.update(patch, ["id"])} WHERE ${sql("id")} = ${id}`
```

Notes on identifier escaping: identifiers interpolate through `sql("name")` and are
escaped with the dialect quote character, doubled quotes inside the name, and dot
segmenting through `Statement.defaultEscape`. Table names in the migrator interpolate the
same way, for example `${sql(table)}`.

## Transactions

`SqlClient.withTransaction` wraps an effect in a transaction. Inside, statements reuse the
transaction connection through the client's `transactionService` context key, so no
explicit connection threading is needed:

```typescript
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const transfer = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE ${sql("accounts")} SET balance = balance - 100 WHERE ${sql("id")} = 1`
    yield* sql`UPDATE ${sql("accounts")} SET balance = balance + 100 WHERE ${sql("id")} = 2`
})

// withTransaction is an instance method of the client
const transferTx = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(transfer)
})
```

Semantics, verified in `SqlClient.makeWithTransaction`:

1. Top level transactions run `BEGIN` and `COMMIT`, and roll back on failure or
   interruption.
2. Nested calls inside a running transaction create a savepoint pair instead. A nested
   failure rolls back to its savepoint only, and the outer effect decides the outcome.
3. The wrapped effect runs under an uninterruptible region, and concurrent nested
   transactions serialize through a per transaction semaphore.
4. The error channel gains `SqlError` for begin, commit, and rollback failures, and keeps
   the wrapped effect's own errors unchanged.

Because nested calls are savepoints, an effect composed of smaller transactional
functions still produces one physical transaction.

## SqlSchema: Typed Queries

`SqlSchema` wraps an executor with a request schema and a result schema. Requests are
encoded before execution, rows are decoded after:

```typescript
import { Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"

class User extends Schema.Class<User>("User")({
    id: Schema.Number,
    name: Schema.String,
}) {}

const findOneById = SqlSchema.findOne({
    Request: Schema.Number,
    Result: User,
    execute: (id) => Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT * FROM ${sql("users")} WHERE ${sql("id")} = ${id}`
    }),
})

const search = SqlSchema.findAll({
    Request: Schema.Struct({ term: Schema.String }),
    Result: User,
    execute: (req) => Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT * FROM ${sql("users")} WHERE ${sql("name")} LIKE ${req.term}`
    }),
})
```

The five helpers, all verified exports of `SqlSchema`:

| Helper | Result | Empty result behavior |
| --- | --- | --- |
| `SqlSchema.findAll` | `Array<Result>` | empty array |
| `SqlSchema.findNonEmpty` | `NonEmptyArray<Result>` | fails with `NoSuchElementError` |
| `SqlSchema.findOne` | `Result` | fails with `NoSuchElementError` |
| `SqlSchema.findOneOption` | `Option<Result>` | `Option.none` |
| `SqlSchema.void` | `void` | result discarded |

Decoding failures surface as `Schema.SchemaError` in the error channel, joined with the
executor's own error type. `NoSuchElementError` comes from `Cause`.

## SqlResolver: Batched Data Loading

`SqlResolver` represents a lookup or mutation as a `SqlRequest` payload and batches
concurrent requests through Effect's `Request` module. Construct a resolver once, then
issue requests with `Effect.request`. Concurrent requests are deduplicated by payload
equality, batched into one SQL call, and each request completes with its own exit:

```typescript
import { Effect, Schema } from "effect"
import { SqlClient, SqlResolver } from "effect/unstable/sql"

class User extends Schema.Class<User>("User")({
    id: Schema.Number,
    name: Schema.String,
}) {}

const makeUserByIdResolver = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return SqlResolver.findById({
        Id: Schema.Number,
        Result: User,
        ResultId: (user) => user.id,
        execute: (ids) =>
            sql`SELECT * FROM ${sql("users")} WHERE ${sql.in("id", ids)}`,
    })
})

const program = Effect.gen(function* () {
    const resolveUser = yield* makeUserByIdResolver
    // Five concurrent requests for overlapping ids become one SELECT
    const [alice, bob] = yield* Effect.all([
        SqlResolver.request(1, resolveUser),
        SqlResolver.request(2, resolveUser),
    ], { concurrency: 2 })
})
```

The constructors:

| Constructor | Shape |
| --- | --- |
| `SqlResolver.ordered` | one batch, results zipped to requests by position, length mismatch fails with `ResultLengthMismatch` |
| `SqlResolver.grouped` | results grouped by a result key, each request gets its group, missing group fails with `NoSuchElementError` |
| `SqlResolver.findById` | rows matched to requests by `ResultId`, missing ids fail with `NoSuchElementError` |
| `SqlResolver.void` | side effect only batches, no result matching |

Two behaviors worth knowing:

1. Batches are separated by the active transaction connection, so requests inside a
   transaction join their own transaction's batch and never read through a different
   connection.
2. Deduplication is based on payload equality and hashing, so identical concurrent
   requests collapse into a single batch entry.

Because these are ordinary `RequestResolver` values, they compose with fiber level
caching. See `v4-semantics.md` for how `Effect.request` participates in deduplication and
caching at the fiber level.

## Migrations

The core `Migrator.make` builds a migrator from a loader. Loaders read migration files
named `<id>_<name>.ts` and sort by id. `Migrator.fromFileSystem` reads a directory with
the `FileSystem` and `Path` services:

```typescript
import { Effect } from "effect"
import { Migrator } from "effect/unstable/sql"
import { PgMigrator } from "@effect/sql-pg"

const runMigrations = PgMigrator.run({
    loader: Migrator.fromFileSystem("./migrations"),
    table: "my_app_migrations", // defaults to "effect_sql_migrations"
})
// Effect<ReadonlyArray<readonly [id, name]>, MigrationError | SqlError,
//        SqlClient | PgClient | FileSystem | Path | ChildProcessSpawner>
// Provide the client layer and a FileSystem with Path, such as NodeContext.layer

// Or run during layer construction
const MigrationsLive = PgMigrator.layer({
    loader: Migrator.fromFileSystem("./migrations"),
})
// Layer<never, MigrationError | SqlError, SqlClient | PgClient | FileSystem | Path | ...>
```

Useful facts, verified in `Migrator.ts` and `PgMigrator.ts`:

1. The migrations table is created when missing, with `migration_id`, `name`, and
   `created_at` columns. The default name is `effect_sql_migrations`.
2. Pending migrations run inside a single transaction. Postgres additionally takes an
   `ACCESS EXCLUSIVE` lock on the table.
3. Duplicate ids fail with `MigrationError` of kind `Duplicates`. A concurrent run fails
   with kind `Locked`, which the migrator logs and treats as a no-op.
4. Each migration is a module whose default export is an `Effect` that requires
   `SqlClient`.
5. `Migrator.fromGlob`, `Migrator.fromBabelGlob`, and `Migrator.fromRecord` cover bundled
   and inline loaders.
6. `PgMigrator.run` supports `schemaDirectory`, which runs `pg_dump` through
   `ChildProcessSpawner`, `FileSystem`, and `Path`. `PgMigrator.layer(options)` runs the
   migrator during layer construction.

## Errors

`SqlError` is a `Schema.TaggedError` wrapper with tag `SqlError`, holding a structured
`reason` that is one of a closed union of reason tags:

`ConnectionError`, `AuthenticationError`, `AuthorizationError`, `SqlSyntaxError`,
`UniqueViolation`, `ConstraintError`, `DeadlockError`, `SerializationError`,
`LockTimeoutError`, `StatementTimeoutError`, `UnknownError`.

The reason carries `message`, optional `cause` and `operation`, and an `isRetryable`
getter. Connection failures are retryable, everything else is not. `UniqueViolation` and
`ConstraintError` additionally carry the violated `constraint` name:

```typescript
import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

const saveUser = (user: NewUser) =>
    Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO ${sql("users")} ${sql.insert(user)}`
    })

const register = (user: NewUser) =>
    saveUser(user).pipe(
        Effect.catchTag("SqlError", (error) => {
            switch (error.reason._tag) {
                case "UniqueViolation":
                    return Effect.fail(new EmailTakenError({ constraint: error.reason.constraint }))
                case "DeadlockError":
                case "ConnectionError":
                    return Effect.fail(new TransientDbError({ retryable: error.reason.isRetryable }))
                default:
                    return Effect.die(error) // unexpected SQL states become defects
            }
        }),
    )
```

Map SQL errors at the repository boundary. The repo's own error channel carries domain
errors, and unexpected SQL states are promoted to defects. This matches the per layer
mapping convention in `error-patterns.md` and keeps `SqlError` out of service-level
signatures. The guard `SqlError.isSqlError(value)` narrows unknown values at runtime,
useful in `Effect.filterOrElse` or interop boundaries.

## Streaming Large Results

`Statement.stream` returns `Stream<A, SqlError>` and pulls rows incrementally instead of
materializing the full result set:

```typescript
import { Effect, Sink, Stream } from "effect"

const exportUsers = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`SELECT * FROM ${sql("users")}`.stream.pipe(
        Stream.run(Sink.forEach((user: UserRow) => Effect.logInfo(user.name))),
    )
})
```

Provider packages drive this with the interop helper `SqlStream.asyncPauseResume` from
`effect/unstable/sql`, which adapts callback style cursors and emitters into a Stream with
backpressure. Application code consumes `.stream` and does not need the adapter.

## Layer Wiring

`PgClient.layerConfig` builds a pooled client from `Config` values and provides both the
`PgClient` and `SqlClient` context keys:

```typescript
import { Config, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"

const DatabaseLive = PgClient.layerConfig({
    host: Config.String("DB_HOST"),
    port: Config.Int("DB_PORT"),
    database: Config.String("DB_NAME"),
    username: Config.String("DB_USER"),
    password: Config.Redacted("DB_PASSWORD"),
})
// ^? Layer<PgClient | SqlClient, Config.ConfigError | SqlError>
```

Note the error channel: it includes `SqlError`, because the pool can fail to establish its
first connections. `PgClient.layer(config)` takes concrete values and returns
`Layer<PgClient | SqlClient, SqlError>`.

Share one client between repos through layer memoization, matching the composition rules
in `layer-patterns.md`:

```typescript
const RepoLive = Layer.mergeAll(UserRepo.layer, OrderRepo.layer, AuditRepo.layer)

const AppLive = RepoLive.pipe(
    Layer.provide(DatabaseLive), // one pool, shared by all three repos
)
```

Layers memoize construction, so all repos that yield the same context key get the same
pool. `PgClient.layerFrom(acquire)` is the escape hatch when the client is built by a
custom effect, and it still provides both context keys.

For concrete config without environment variables, use `PgClient.layer`:

```typescript
const DatabaseLocal = PgClient.layer({
    host: "localhost",
    port: 5432,
    database: "app",
    username: "postgres",
    password: "postgres",
})
```

The pool knobs live on `PgPoolConfig`: `maxConnections`, `minConnections`,
`idleTimeout`, and `connectionTTL`. Two flags worth knowing on `PgClientConfig`:
`prepare: false` for poolers that cannot preserve named prepared statements, and
`multiplex: true` to pipeline queries from multiple fibers onto pooled connections.

## SqlModel: Generated CRUD Repositories

`SqlModel.makeRepository` builds insert, update, `findById`, and delete operations for a
`Model.Any` schema, with optional soft delete support:

```typescript
import { SqlModel } from "effect/unstable/sql"

const UserRepo = SqlModel.makeRepository(UserModel, {
    tableName: "users",
    spanPrefix: "UserRepo",
    idColumn: "id",
})
// Effect with operations requiring SqlClient in its R channel
```

Use it when a table maps one to one to a schema model. Reach for `SqlSchema` when the
queries outgrow basic CRUD.

## Anti-Patterns

### String Concatenation Into Queries

```typescript
// WRONG, interpolation outside the template, injection and type loss
const byName = (name: string) => sql`SELECT * FROM users WHERE name = '${name}'`
const byNameUnsafe = (name: string) => sql.unsafe(`SELECT * FROM users WHERE name = '${name}'`)
```

```typescript
// CORRECT, the value is bound, and no quoting is needed
const byName = (name: string) => sql`SELECT * FROM ${sql("users")} WHERE ${sql("name")} = ${name}`
```

`sql.unsafe` exists for raw SQL with explicit params, not for string building.

### Running SQL Effects Eagerly

```typescript
// WRONG, the statement runs when make runs, not when the method runs
export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
    make: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const allUsers = yield* sql`SELECT * FROM ${sql("users")}` // runs once at construction
        return { allUsers }
    }),
}) {}
```

```typescript
// CORRECT, store the client, build statements lazily per call
export class UserRepo extends Context.Service<UserRepo>()("UserRepo", {
    make: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const findAll = Effect.fn("UserRepo.findAll")(
            () => sql`SELECT * FROM ${sql("users")}`,
        )
        return { findAll }
    }),
}) {}
```

### Leaking SqlError Past the Repo Layer

```typescript
// WRONG, SqlError escapes into the service signature
const findById = (id: UserId) => schema.findOneById(id)
//      ^? Effect<User, SqlError | Schema.SchemaError | NoSuchElementError, ...>

// CORRECT, map at the repo boundary, matching error-patterns.md
const findById = Effect.fn("UserRepo.findById")(
    (id: UserId) => schema.findOneById(id),
    (effect, id) => effect.pipe(
        Effect.catchTag("SqlError", (err) =>
            err.reason._tag === "DeadlockError"
                ? Effect.fail(new TransientDbError({ message: "deadlock" }))
                : Effect.die(err),
        ),
        Effect.catchTag("NoSuchElementError", () =>
            Effect.fail(new UserNotFoundError({ userId: id })),
        ),
    ),
)
```

### Manual Connection Pooling Instead of the Client Layer

```typescript
// WRONG, a hand rolled pool fights the client's acquirer, borrower, and transaction logic
const myPool = { connections: new Set(), acquire: () => Effect.succeed(conn) }
```

The provider layer owns connection acquisition, the borrower fast path, transaction
connection reuse, and statement preparation. Construct the client with its layer or its
`make` constructor and let the pool belong to the layer. If two repos must not share a
pool, use `Layer.fresh` as described in `layer-patterns.md`.

## Cross References

- `service-patterns.md`: `Context.Service` definitions and `Effect.fn` error transforms.
- `layer-patterns.md`: `layerConfig` composition, memoization, and `Layer.fresh`.
- `error-patterns.md`: `catchTag` and `catchTags` conventions, retryability handling.
- `resource-patterns.md`: scoped acquisition for pool lifecycles and `FileSystem` / `Path`
  services used by the migration loader.
- `v4-semantics.md`: fiber level request caching behind `Effect.request`.
