# RPC and Cluster Patterns

> **Effect v4.** RPC modules live in `effect/unstable/rpc`. Cluster modules live in
> `effect/unstable/cluster`. Workflow modules live in `effect/unstable/workflow`.

## RpcGroup for API Organization

**Use `Rpc.make` for each endpoint and `RpcGroup.make` to collect them:**

```typescript
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Effect, Schema } from "effect"

export const UserRpcs = RpcGroup.make(
    Rpc.make("findById", {
        payload: { id: UserId },
        success: User,
        error: UserNotFoundError,
    }),

    Rpc.make("list", {
        payload: {
            organizationId: OrganizationId,
            limit: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.succeed(50))),
            offset: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.succeed(0))),
        },
        success: Schema.Array(User),
    }),

    Rpc.make("create", {
        payload: CreateUserInput,
        success: User,
        error: Schema.Union([UserCreateError, ValidationError]),
    }),

    Rpc.make("update", {
        payload: { id: UserId, data: UpdateUserInput },
        success: User,
        error: Schema.Union([UserNotFoundError, ValidationError]),
    }),

    Rpc.make("delete", {
        payload: { id: UserId },
        error: UserNotFoundError,
    }),
)
```

### Rpc.make Options

| Option       | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `payload`    | Request schema, a `Schema.Struct` or a bare fields object      |
| `success`    | Success schema, defaults to `Schema.Void`                      |
| `error`      | Error schema, defaults to `Schema.Never`                       |
| `stream`     | `true` for a streaming response                                |
| `primaryKey` | Derives a request identity, needed for deduplication           |
| `defect`     | Schema for defects, defaults to `Schema.Defect()`              |

`success` and `error` are optional. Omit `error` rather than writing `Schema.Never`, and omit
`success` for a void response.

Model read and write differences with annotations (for example `Persisted` or
`Uninterruptible`) where the distinction matters operationally. Declare each contract
explicitly with `Rpc.make`.

## Error Unions in RPC

**Always use explicit error unions.** `Schema.Union` takes one array:

```typescript
// Explicit union of possible errors
Rpc.make("create", {
    payload: CreateOrderInput,
    success: Order,
    error: Schema.Union([
        ValidationError,
        InsufficientInventoryError,
        PaymentFailedError,
        UserNotFoundError,
    ]),
})

// NOT a generic error type
Rpc.make("create", {
    payload: CreateOrderInput,
    success: Order,
    error: GenericError, // WRONG, loses type information
})
```

## RPC Middleware for Authentication

`RpcMiddleware.Service` is configured with `requires`, `provides`, and `error` type parameters
plus an options object:

```typescript
import { Rpc, RpcMiddleware } from "effect/unstable/rpc"
import { Context, Effect, Layer } from "effect"

// The authenticated user is a service key the middleware provides
export class CurrentUser extends Context.Service<
    CurrentUser,
    { id: UserId; role: UserRole; organizationId: OrganizationId }
>()("CurrentUser") {}

// Auth middleware
export class AuthMiddleware extends RpcMiddleware.Service<
    AuthMiddleware,
    { provides: CurrentUser }
>()("AuthMiddleware", {
    error: UnauthorizedError,
}) {}

// Middleware implementation
export const AuthMiddlewareLive = Layer.effect(
    AuthMiddleware,
    Effect.gen(function* () {
        const authService = yield* AuthService

        return AuthMiddleware.of({
            execute: (request) =>
                Effect.gen(function* () {
                    const token = request.headers.get("authorization")?.replace("Bearer ", "")

                    if (!token) {
                        return yield* Effect.fail(new UnauthorizedError({ message: "Missing token" }))
                    }

                    return yield* authService.validateToken(token).pipe(
                        Effect.catchTag("TokenExpiredError", () =>
                            Effect.fail(new UnauthorizedError({ message: "Token expired" }))
                        ),
                        Effect.catchTag("TokenInvalidError", () =>
                            Effect.fail(new UnauthorizedError({ message: "Invalid token" }))
                        ),
                    )
                }),
        })
    })
)

// Protected RPCs using middleware
export const ProtectedUserRpcs = UserRpcs.middleware(AuthMiddleware)
```

Set `requiredForClient: true` in the options when the client must supply the middleware too.
The middleware `provides` metadata removes that service from each handler requirements, so
handlers can yield `CurrentUser` without declaring it.

## Workflow Definition

**Use `Workflow.make(tag, options)`.** The name is the first argument:

```typescript
import { Workflow } from "effect/unstable/workflow"
import { Schema } from "effect"

export const OrderFulfillmentWorkflow = Workflow.make("OrderFulfillmentWorkflow", {
    payload: {
        orderId: OrderId,
        userId: UserId,
        items: Schema.Array(OrderItem),
        shippingAddress: ShippingAddress,
    },
    // Idempotency key prevents duplicate processing
    idempotencyKey: ({ orderId }) => orderId,
    success: FulfillmentResult,
    error: Schema.Union([FulfillmentFailedError, PaymentFailedError]),
})

export const NotificationWorkflow = Workflow.make("NotificationWorkflow", {
    payload: {
        messageId: MessageId,
        channelId: ChannelId,
        authorId: UserId,
    },
    idempotencyKey: ({ messageId }) => messageId,
})
```

`idempotencyKey` is **required**. Workflow definitions expose `_tag` and work as constructors.
Use the idempotency key for identity.

### Workflow Implementation

```typescript
import { Activity } from "effect/unstable/workflow"
import { Effect, Schema } from "effect"

export const OrderFulfillmentWorkflowLayer = OrderFulfillmentWorkflow.toLayer(
    Effect.fn("OrderFulfillmentWorkflow")(function* (payload) {
        // Step 1: Reserve inventory
        const reservation = yield* Activity.make({
            name: "ReserveInventory",
            success: InventoryReservation,
            error: Schema.Union([InsufficientInventoryError, DatabaseError]),
            execute: Effect.gen(function* () {
                const inventory = yield* InventoryService
                return yield* inventory.reserve(payload.items)
            }),
        })

        // Step 2: Process payment
        const payment = yield* Activity.make({
            name: "ProcessPayment",
            success: PaymentResult,
            error: Schema.Union([PaymentFailedError, PaymentTimeoutError]),
            execute: Effect.gen(function* () {
                const payments = yield* PaymentService
                return yield* payments.charge(payload.userId, payload.items)
            }),
        })

        // Step 3: Create shipment
        const shipment = yield* Activity.make({
            name: "CreateShipment",
            success: Shipment,
            error: Schema.Union([ShippingError, AddressInvalidError]),
            execute: Effect.gen(function* () {
                const shipping = yield* ShippingService
                return yield* shipping.createShipment({
                    items: payload.items,
                    address: payload.shippingAddress,
                    reservationId: reservation.id,
                })
            }),
        })

        // Step 4: Send confirmation
        yield* Activity.make({
            name: "SendConfirmation",
            error: NotificationError,
            execute: Effect.gen(function* () {
                const notifications = yield* NotificationService
                yield* notifications.sendOrderConfirmation({
                    userId: payload.userId,
                    orderId: payload.orderId,
                    trackingNumber: shipment.trackingNumber,
                })
            }),
        })

        return { shipment, payment }
    })
)
```

## Activity Patterns

**Always include `success` and `error` schemas** when the activity produces or fails with a
value. The schemas are what survives a workflow restart:

```typescript
// CORRECT, schemas specified
yield* Activity.make({
    name: "SendEmail",
    success: EmailSentResult,
    error: Schema.Union([EmailDeliveryError, EmailTemplateError]),
    execute: Effect.gen(function* () {
        // Implementation
        const clock = yield* Clock.currentTimeMillis
        return { messageId: "msg-123", sentAt: clock }
    }),
})

// WRONG, result cannot be replayed across restarts
yield* Activity.make({
    name: "SendEmail",
    execute: Effect.gen(function* () {
        return { messageId: "msg-123" } // not serialized, lost on replay
    }),
})
```

`success` defaults to `Schema.Void` and `error` to `Schema.Never`, so omitting them is correct
for a void, infallible activity, and incorrect when the activity returns data.

`interruptRetryPolicy` controls retry on interrupt behavior per activity.

### Activity Error Handling with Retryable

```typescript
export class ExternalApiError extends Schema.TaggedError<ExternalApiError>()(
    "ExternalApiError",
    {
        message: Schema.String,
        statusCode: Schema.Number,
        retryable: Schema.Boolean,
    },
) {
    static fromResponse(response: Response): ExternalApiError {
        return new ExternalApiError({
            message: `API error: ${response.statusText}`,
            statusCode: response.status,
            retryable: response.status >= 500, // 5xx errors are retryable
        })
    }
}

yield* Activity.make({
    name: "CallExternalApi",
    success: ApiResponse,
    error: ExternalApiError,
    execute: Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.get(url)
        if (response.status >= 400) {
            return yield* Effect.fail(ExternalApiError.fromResponse(response))
        }
        return yield* response.json
    }),
})
```

## ClusterCron for Scheduled Jobs

`ClusterCron.make` returns a `Layer` directly and takes the work inline as `execute`. The
schedule is a parsed `Cron`:

```typescript
import { Cron, Effect } from "effect"
import { ClusterCron } from "effect/unstable/cluster"

export const DailyReportCronLayer = ClusterCron.make({
    name: "DailyReportCron",
    // Cron expression: every day at 6 AM UTC
    cron: Cron.parseUnsafe("0 6 * * *"),
    execute: Effect.gen(function* () {
        yield* Effect.log("Starting daily report generation")

        const reports = yield* ReportService
        yield* reports.generateDailyReport()

        yield* Effect.log("Daily report generation complete")
    }),
})
```

Use `Cron.parse(expr)` when you want the `Result` form. Other options include `shardGroup` to
pin the job to a shard group, `calculateNextRunFromPrevious`, and `skipIfOlderThan` (defaults
to `"1 day"`) to skip badly delayed runs.

The layer requires `Sharding`, so provide your cluster layer beneath it.

## Triggering Workflows

### From an HTTP Handler

```typescript
import { HttpApiBuilder, HttpApiEndpoint } from "effect/unstable/httpapi"

const createOrder = HttpApiEndpoint.post("createOrder", "/orders", {
    payload: CreateOrderInput,
    success: Order,
    error: ValidationError,
})

const OrdersApiLive = HttpApiBuilder.group(Api, "orders", (handlers) =>
    handlers.handle("createOrder", ({ payload }) =>
        Effect.gen(function* () {
            const orders = yield* OrderService

            // Create order in database
            const order = yield* orders.create(payload)

            // Trigger async fulfillment workflow
            yield* OrderFulfillmentWorkflow.execute({
                orderId: order.id,
                userId: payload.userId,
                items: payload.items,
                shippingAddress: payload.shippingAddress,
            })

            return order
        })
    )
)
```

`execute` requires the `WorkflowEngine` service, provided by the cluster workflow
engine layer at the application root.

### From a Backend Service

```typescript
export class MessageService extends Context.Service<MessageService>()("MessageService", {
    make: Effect.gen(function* () {
        const repo = yield* MessageRepo

        const create = Effect.fn("MessageService.create")(function* (input: CreateMessageInput) {
            const message = yield* repo.create(input)

            // Trigger notification workflow
            yield* NotificationWorkflow.execute({
                messageId: message.id,
                channelId: message.channelId,
                authorId: message.authorId,
            })

            return message
        })

        return { create }
    }),
}) {
    static readonly layer = Layer.effect(this, this.make).pipe(
        Layer.provide(MessageRepo.layer),
    )
}
```

Both call sites require `WorkflowEngine` in the effect's requirements. Provide it once at the
root with the cluster workflow engine layer, the same layer that runs registered workflows.

## Import Reference

| Module                          | Path                      | Exports                                                            |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| RPC                             | `effect/unstable/rpc`     | `Rpc`, `RpcGroup`, `RpcClient`, `RpcServer`, `RpcMiddleware`        |
| Cluster                         | `effect/unstable/cluster` | `Sharding`, `Entity`, `Singleton`, `ClusterCron`, `ClusterSchema`   |
| Workflow                        | `effect/unstable/workflow`| `Workflow`, `Activity`                                             |

All three are **unstable modules**. Pin your Effect version if you depend on them heavily. See
`v4-semantics.md`.
