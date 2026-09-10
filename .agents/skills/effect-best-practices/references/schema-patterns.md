# Schema Patterns

> **Effect v4 (4.0.0-rc.113).** Schema defines codecs with Type and Encoded forms. Refinements are checks applied with `.check(...)`. Transformations are defined with `decodeTo` and `SchemaTransformation` or `SchemaGetter`. Failures are expressed with `SchemaIssue` and reported as `Schema.SchemaError`. `Schema.brand`, `Schema.Struct`, `Schema.Class`, and `Schema.TaggedError` define nominal types, structs, classes, and errors.

## Branded Types for IDs

**Always brand entity IDs** to prevent accidentally passing the wrong ID type:

```typescript
import { Schema } from "effect"

// Entity IDs, always branded with namespace
export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("@App/UserId"))
export type UserId = Schema.Schema.Type<typeof UserId>

export const OrganizationId = Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand("@App/OrganizationId"),
)
export type OrganizationId = Schema.Schema.Type<typeof OrganizationId>

export const OrderId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("@App/OrderId"))
export type OrderId = Schema.Schema.Type<typeof OrderId>

export const ProductId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("@App/ProductId"))
export type ProductId = Schema.Schema.Type<typeof ProductId>
```

`Schema.String.check(Schema.isUUID())` validates UUID strings. `Schema.isUUID(version?)`
accepts an optional UUID version pin. `Schema.String.check(Schema.isULID())` validates ULID
strings the same way.

### Branding Convention

Use `@Namespace/EntityName` format:

- `@App/UserId` - Main application entities
- `@Billing/InvoiceId` - Billing domain entities
- `@External/StripeCustomerId` - External system IDs

### Creating Branded Values

```typescript
// From string (validates UUID format)
const userId = Schema.decodeSync(UserId)("123e4567-e89b-12d3-a456-426614174000")

// Generate new ID
const newUserId = UserId.make(crypto.randomUUID())

// Type error, IDs do not mix
const order = yield* orderService.findById(userId) // Error: UserId is not OrderId
```

### When NOT to Brand

Don't brand simple strings that need no type safety:

```typescript
// NOT branded, acceptable
export const Url = Schema.String
export const FilePath = Schema.String
export const EmailAddress = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))

// These need no branding because:
// 1. They do not cross service boundaries in ways that could be confused
// 2. They are validated by format, not by type
```

## Checks

Apply refinements as checks with `.check(...)`, which accepts several checks at once:

| Check | Constraint |
| --- | --- |
| `Schema.isPattern(re)` | String matches `re` |
| `Schema.isMinLength(n)`, `Schema.isMaxLength(n)` | String length bounds |
| `Schema.isLengthBetween(min, max)` | String or collection size range, exact length with equal bounds |
| `Schema.isNonEmpty()` | Non empty string or collection |
| `Schema.isInt()` | Integer numbers |
| `Schema.isGreaterThan(n)` | Numbers above `n`, positive numbers with `Schema.isGreaterThan(0)` |
| `Schema.isBetween({ minimum, maximum })` | Numbers within inclusive bounds |
| `Schema.check(Schema.makeFilter(predicate))` | Custom predicate |
| `Schema.refine(refinement)` | Custom type refinement |

```typescript
// One .check call, multiple checks
Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
```

## Schema.Struct for Domain Types

**Prefer Schema.Struct** over TypeScript interfaces for domain types:

```typescript
// CORRECT, Schema.Struct
export const User = Schema.Struct({
    id: UserId,
    email: Schema.String,
    name: Schema.String,
    organizationId: OrganizationId,
    role: Schema.Literals(["admin", "member", "viewer"]),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
})
export type User = Schema.Schema.Type<typeof User>

// Derive encoded type for database and API
export type UserEncoded = Schema.Codec.Encoded<typeof User>
```

`Schema.Literals` takes one array argument. `Schema.Literal` takes exactly one value.
`Schema.Null` covers null. `Schema.DateTimeUtcFromString` decodes ISO date strings.
`Schema.DateTimeUtc` is the self schema for `DateTime` values.

### Input Types for Mutations

```typescript
import { Effect, Schema } from "effect"

export const CreateUserInput = Schema.Struct({
    email: Schema.String.check(
        Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    ).annotate({ description: "Valid email address" }),

    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),

    organizationId: OrganizationId,

    // Absent role decodes to "member", the default is an Effect
    role: Schema.Literals(["admin", "member", "viewer"]).pipe(
        Schema.withDecodingDefaultType(Effect.succeed("member" as const)),
    ),
})
export type CreateUserInput = Schema.Schema.Type<typeof CreateUserInput>

export const UpdateUserInput = Schema.Struct({
    name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    role: Schema.optional(Schema.Literals(["admin", "member", "viewer"])),
})
export type UpdateUserInput = Schema.Schema.Type<typeof UpdateUserInput>
```

## Transforms with decodeTo

Pipe the source schema through `Schema.decodeTo(target, transformation)`.

### Total Transforms

```typescript
import { Schema, SchemaTransformation } from "effect"

// Comma-separated string to array
export const CommaSeparatedList = Schema.String.pipe(
    Schema.decodeTo(
        Schema.Array(Schema.String),
        SchemaTransformation.transform({
            // Annotate both sides: Schema.Array decodes to ReadonlyArray, and
            // the mutable `string[]` that `split` infers is not assignable to it
            decode: (s: string): ReadonlyArray<string> =>
                s.split(",").map((x) => x.trim()).filter(Boolean),
            encode: (arr: ReadonlyArray<string>) => arr.join(","),
        }),
    ),
)

// Cents to dollars
export const DollarsFromCents = Schema.Number.check(Schema.isInt()).pipe(
    Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transform({
            decode: (cents) => cents / 100,
            encode: (dollars) => Math.round(dollars * 100),
        }),
    ),
)
```

### Fallible Transforms

Inside a `SchemaGetter`, signal success with `Effect.succeed` and failure with
`Effect.fail(new SchemaIssue.*)`:

```typescript
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"

export const PositiveNumber = Schema.Number.pipe(
    Schema.decodeTo(Schema.Number.pipe(Schema.brand("PositiveNumber")), {
        decode: SchemaGetter.transformEffect((n: number) =>
            n > 0
                ? Effect.succeed(n)
                : Effect.fail(new SchemaIssue.InvalidValue())
        ),
        encode: SchemaGetter.passthrough(),
    }),
)
```

`Effect.succeed` signals success. `Effect.fail` signals failure.
`SchemaIssue.InvalidType` reports type mismatches.

A simple predicate fits a **check** better than a fallible transform:
`Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PositiveNumber"))`.

### JSON Strings

For JSON strings, define:

```typescript
// JSON string to AppSettings, any schema works as the target
export const AppSettingsFromJson = Schema.fromJsonString(AppSettings)

// Untyped JSON string
export const AnyJson = Schema.UnknownFromJsonString
```

## Schema.Class for Entities with Methods

Use `Schema.Class` when entities need methods:

```typescript
export class User extends Schema.Class<User>("User")({
    id: UserId,
    email: Schema.String,
    name: Schema.String,
    role: Schema.Literals(["admin", "member", "viewer"]),
    createdAt: Schema.DateTimeUtcFromString,
}) {
    get isAdmin(): boolean {
        return this.role === "admin"
    }

    get displayName(): string {
        return this.name || this.email.split("@")[0]
    }

    canAccessResource(resource: Resource): boolean {
        if (this.isAdmin) return true
        return resource.ownerId === this.id
    }
}

// Usage
const user = new User({
    id: UserId.make(crypto.randomUUID()),
    email: "alice@example.com",
    name: "Alice",
    role: "member",
    createdAt: DateTime.nowUnsafe(),
})

console.log(user.displayName) // "Alice"
console.log(user.isAdmin) // false
```

## Annotations

Add documentation and examples with `.annotate(...)`:

```typescript
export const CreateOrderInput = Schema.Struct({
    productId: ProductId.annotate({ description: "The product to order" }),

    quantity: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
        description: "Number of items to order",
        examples: [1, 5, 10],
    }),

    shippingAddress: Schema.Struct({
        line1: Schema.String.annotate({ description: "Street address" }),
        line2: Schema.optional(Schema.String),
        city: Schema.String,
        state: Schema.String.check(Schema.isLengthBetween(2, 2)),
        zip: Schema.String.check(Schema.isPattern(/^\d{5}(-\d{4})?$/)),
    }).annotate({ description: "Shipping destination" }),
}).annotate({
    title: "Create Order Input",
    description: "Input for creating a new order",
})
```

Checks take their own annotations as a trailing argument, as in
`Schema.isMinLength(1, { description: "..." })`, for messages tied to a specific constraint.

## Optional Fields

Struct fields combine distinct combinators for absent keys, `undefined` values, defaults,
and nulls:

| Combinator | Meaning |
| --- | --- |
| `Schema.optional(s)` | Key may be absent or `undefined` |
| `Schema.optionalKey(s)` | Key may be absent, never explicitly `undefined` |
| `s.pipe(Schema.withDecodingDefaultType(Effect.succeed(v)))` | Absent key decodes to `v`, with `v` as a Type value |
| `s.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(v)))` | Key level default, absent key decodes to `v` |
| `Schema.optional(Schema.NullOr(s))` plus `decodeTo` filtering nulls | Nullable input decoded to an optional field |

```typescript
import { Effect, Schema } from "effect"

export const UserPreferences = Schema.Struct({
    // Optional, undefined if not provided
    theme: Schema.optional(Schema.Literals(["light", "dark"])),

    // Optional with default value
    language: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("en"))),

    // Nullable (for database compatibility)
    bio: Schema.NullOr(Schema.String),

    // Key may be absent, but never explicitly undefined
    timezone: Schema.optionalKey(Schema.String),
})
```

The default is an **`Effect`**, not a thunk. Write `Effect.succeed("en")`, not `() => "en"`. Use
`withDecodingDefault*` (without `Type`) when the default is expressed in `Encoded` terms rather
than `Type` terms.

## Union Types and Discriminated Unions

`Schema.Union` takes one array:

```typescript
// Simple union, prefer Literals for a set of literals
export const PaymentMethod = Schema.Literals(["card", "bank_transfer", "crypto"])

// Discriminated union (tagged)
export const PaymentDetails = Schema.Union([
    Schema.Struct({
        _tag: Schema.Literal("Card"),
        cardNumber: Schema.String,
        expiry: Schema.String,
        cvv: Schema.String,
    }),
    Schema.Struct({
        _tag: Schema.Literal("BankTransfer"),
        accountNumber: Schema.String,
        routingNumber: Schema.String,
    }),
    Schema.Struct({
        _tag: Schema.Literal("Crypto"),
        walletAddress: Schema.String,
        network: Schema.Literals(["ethereum", "bitcoin", "solana"]),
    }),
])
export type PaymentDetails = Schema.Schema.Type<typeof PaymentDetails>

// Usage with switch
const processPayment = (details: PaymentDetails) => {
    switch (details._tag) {
        case "Card":
            return processCard(details.cardNumber, details.expiry, details.cvv)
        case "BankTransfer":
            return processBankTransfer(details.accountNumber, details.routingNumber)
        case "Crypto":
            return processCrypto(details.walletAddress, details.network)
    }
}
```

`Schema.TaggedStruct(tag, fields)` is the shorthand for a `_tag`-discriminated struct.
`Schema.Tuple` takes one array: `Schema.Tuple([A, B])`.

## Enums and Literals

```typescript
// Use Literals for small, fixed sets
export const UserRole = Schema.Literals(["admin", "member", "viewer"])
export type UserRole = Schema.Schema.Type<typeof UserRole>

// Use Enum for larger sets or when runtime values help
export const OrderStatus = Schema.Enum({
    Pending: "pending",
    Processing: "processing",
    Shipped: "shipped",
    Delivered: "delivered",
    Cancelled: "cancelled",
} as const)
export type OrderStatus = Schema.Schema.Type<typeof OrderStatus>
```

## Recursive Schemas

```typescript
interface Category {
    id: string
    name: string
    children: readonly Category[]
}

export const Category = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)),
})
```

## Decoding and Encoding

Effectful codecs end with `Effect`. `Exit` variants return `Exit`. Sync codecs throw
`SchemaError` on failure:

| Function | Result |
| --- | --- |
| `Schema.decodeUnknownEffect(s)` | Effect decoding `unknown` input, fails with `SchemaError` |
| `Schema.decodeEffect(s)` | Effect decoding Type input, fails with `SchemaError` |
| `Schema.decodeUnknownExit(s)` | `Exit` decoding `unknown` input |
| `Schema.encodeEffect(s)` | Effect encoding to Encoded form, fails with `SchemaError` |
| `Schema.encodeUnknownExit(s)` | `Exit` encoding `unknown` input |
| `Schema.decodeUnknownSync(s)` | Sync decoding of `unknown` input |
| `Schema.decodeSync(s)` | Sync decoding of Type input |

```typescript
// Decode (parse), use in services
const parseUser = Schema.decodeUnknownEffect(User)
const result = yield* parseUser(rawData) // Effect<User, SchemaError>

// Decode sync, only in controlled contexts
const user = Schema.decodeUnknownSync(User)(rawData)

// Encode, for serialization
const encodeUser = Schema.encodeEffect(User)
const encoded = yield* encodeUser(user) // Effect<UserEncoded, SchemaError>
```

The failure type is `Schema.SchemaError`, so a decode failure is caught with
`Effect.catchTag("SchemaError", ...)`. Inside a service, a decode failure is often **your**
bug, not the caller's, so `Effect.die` it rather than surfacing it. See `error-patterns.md`.

## Structural Field Operations

Derive structs with `mapFields`:

| Goal | Pattern |
| --- | --- |
| Pick keys | `schema.mapFields(Struct.pick(["a"]))` |
| Omit keys | `schema.mapFields(Struct.omit(["a"]))` |
| All fields optional | `schema.mapFields(Struct.map(Schema.optional))` |
| All fields required | `schema.mapFields(Struct.map(Schema.requiredKey))`, every field must already be `optionalKey` |
| Add fields | `schema.mapFields(Struct.assign(otherFields))` |
| Dictionary | `Schema.Record(key, value)` with separate key and value arguments |
