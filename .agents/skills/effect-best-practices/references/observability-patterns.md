# Observability Patterns

> **Effect v4.** `Effect.log` covers structured logging, `Effect.fn` covers tracing, `Metric`
> covers counters and gauges, and `Config` covers typed configuration loading.

## Structured Logging with Effect.log

**Always use Effect.log** instead of console.log. Effect.log provides:

- Structured data
- Log levels
- Integration with telemetry systems
- Testability

### Basic Logging

```typescript
// Simple message
yield* Effect.log("Processing started")

// With structured data
yield* Effect.log("Processing order", {
    orderId,
    userId,
    amount,
    currency,
})

// Different log levels
yield* Effect.logDebug("Cache lookup", { key, hit: true })
yield* Effect.logInfo("User logged in", { userId })
yield* Effect.logWarning("Rate limit approaching", { current: 95, limit: 100 })
yield* Effect.logError("Payment failed", { orderId, reason: error.message })
yield* Effect.logFatal("Database connection lost")
```

### Logging in Services

```typescript
const processOrder = Effect.fn("OrderService.processOrder")(function* (input: OrderInput) {
    yield* Effect.log("Starting order processing", { orderId: input.orderId })

    const result = yield* validateAndProcess(input).pipe(
        Effect.tap(() => Effect.log("Order processed successfully")),
        Effect.tapError((err) =>
            Effect.logError("Order processing failed", {
                orderId: input.orderId,
                error: err._tag,
                message: err.message,
            })
        ),
    )

    return result
})
```

## Effect.fn for Automatic Tracing

**Always use Effect.fn** for service methods. This automatically creates spans with proper names:

```typescript
// Creates span: "UserService.findById"
const findById = Effect.fn("UserService.findById")(function* (id: UserId) {
    // Automatic span creation with:
    // - Start and end timing
    // - Error capture
    // - Parameter tracking (if annotated)
})

// Creates span: "PaymentService.processPayment"
const processPayment = Effect.fn("PaymentService.processPayment")(
    function* (orderId: OrderId, amount: number) {
        // ...
    }
)
```

`Effect.fnUntraced` is the opt-out for hot paths, or for functions that only wrap an
`Effect.gen` and do not warrant their own span.

### Naming Convention

Use `ServiceName.methodName` format consistently:

- `UserService.findById`
- `OrderService.create`
- `PaymentService.refund`
- `NotificationService.sendEmail`

## Span Annotations

Add important context to spans, but do not overdo it:

```typescript
const processOrder = Effect.fn("OrderService.process")(function* (orderId: OrderId) {
    // GOOD, important business identifiers
    yield* Effect.annotateCurrentSpan("orderId", orderId)
    yield* Effect.annotateCurrentSpan("userId", order.userId)
    yield* Effect.annotateCurrentSpan("totalAmount", order.total)

    // BAD, too much detail, creates noise
    // yield* Effect.annotateCurrentSpan("step", "validating")
    // yield* Effect.annotateCurrentSpan("itemCount", order.items.length)
    // yield* Effect.annotateCurrentSpan("item0Name", order.items[0].name)
})
```

### What to Annotate

**Do annotate:**

- Entity IDs (orderId, userId, and similar)
- Important business values (amounts, statuses)
- Error context when failing

**Do not annotate:**

- Step-by-step progress
- Individual item details
- Internal implementation state
- Sensitive data (PII, secrets)

## Metrics

Metric operations in Effect v4:

| API | Purpose |
| ----- | --------- |
| `Metric.counter(name, opts?)` | Define a monotonically increasing counter |
| `Metric.gauge(name, opts?)` | Define a gauge holding a current value |
| `Metric.histogram(name, opts?)` | Define a histogram with explicit boundaries |
| `Metric.timer(name, opts?)` | Define a duration histogram |
| `Metric.update(metric, value)` | Add to a counter, or set a gauge to an absolute value |
| `Metric.modify(metric, delta)` | Apply a delta to a gauge |
| `Metric.withAttributes(metric, attrs)` | Attach attributes to a metric |

`update` sets a gauge absolute value. `modify` applies a delta. For counters, `update` adds.

### Counter

```typescript
import { Effect, Metric } from "effect"

// Define metrics at module level
const ordersProcessed = Metric.counter("orders_processed", {
    description: "Total orders processed",
})

const ordersFailed = Metric.counter("orders_failed", {
    description: "Total orders that failed processing",
})

// Use in service
const processOrder = Effect.fn("OrderService.process")(function* (input: OrderInput) {
    return yield* process(input).pipe(
        Effect.tap(() => Metric.update(ordersProcessed, 1)),
        Effect.tapError(() => Metric.update(ordersFailed, 1)),
    )
})
```

### Counter with Attributes

Attributes are applied to the metric rather than piped onto the update:

```typescript
const httpRequests = Metric.counter("http_requests_total", {
    description: "Total HTTP requests",
})

yield* Metric.update(
    Metric.withAttributes(httpRequests, {
        method: request.method,
        status: String(response.status),
        path: request.path,
    }),
    1,
)
```

### Gauge

```typescript
const activeConnections = Metric.gauge("active_connections", {
    description: "Number of active connections",
})

// Set an absolute value
yield* Metric.update(activeConnections, connectionCount)

// Apply a delta
yield* Metric.modify(activeConnections, 1)
yield* Metric.modify(activeConnections, -1)
```

### Histogram and Timer

```typescript
const requestDuration = Metric.histogram("request_duration_ms", {
    description: "Request duration in milliseconds",
    boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000],
})

// Record value
yield* Metric.update(requestDuration, durationMs)

// Metric.timer builds a duration histogram directly
const handlerDuration = Metric.timer("handler_duration", {
    description: "Handler execution time",
})
```

## Configuration with Config

**Always use Config** instead of process.env.

The error type is `Config.ConfigError`. Validation is expressed with Schema checks read through
`Config.schema`.

### Basic Config

```typescript
import { Config, Effect, Layer } from "effect"

const config = Config.all({
    port: Config.Int("PORT").pipe(Config.withDefault(3000)),
    host: Config.String("HOST").pipe(Config.withDefault("localhost")),
    env: Config.Literals(["development", "staging", "production"], "NODE_ENV"),
})

// Use in a layer
const ServerLive = Layer.unwrap(
    Effect.gen(function* () {
        const { port, host, env } = yield* config
        return Layer.succeed(ServerConfig, { port, host, env })
    })
)
```

`Config.Port` is a built-in for the common case: it validates 1 to 65535 for you.

### Config with Validation

Attach checks to a schema and read it with `Config.schema`:

```typescript
import { Config, Schema } from "effect"

const dbConfig = Config.all({
    host: Config.String("DB_HOST"),

    // Built-in, validates the 1 to 65535 range
    port: Config.Port("DB_PORT"),

    database: Config.String("DB_NAME"),

    // Custom range with a Schema check
    maxConnections: Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "DB_MAX_CONNECTIONS",
    ).pipe(Config.withDefault(10)),
})
```

The check annotations carry the failure message, as in
`Schema.isGreaterThan(0, { description: "Max connections must be positive" })`.

### Redacted Config

```typescript
import { Config, Effect, Redacted } from "effect"

// For sensitive values that should not be logged
const secretConfig = Config.all({
    apiKey: Config.Redacted("API_KEY"),           // Returns Redacted<string>
    dbPassword: Config.Redacted("DB_PASSWORD"),
})

// Using redacted values
const program = Effect.gen(function* () {
    const { apiKey, dbPassword } = yield* secretConfig

    // Redacted values are wrapped, use Redacted.value to unwrap
    const key = Redacted.value(apiKey)

    // Logging a Redacted shows "<redacted>"
    yield* Effect.log("Config loaded", { apiKey }) // Safe, shows <redacted>
})
```

`Config.Redacted` returns `Redacted<string>`. To redact an existing config value, use
`Config.map(config, Redacted.make)`.

### Config with Nested Structure

```typescript
const appConfig = Config.all({
    server: Config.all({
        port: Config.Int("SERVER_PORT"),
        host: Config.String("SERVER_HOST"),
    }),
    database: Config.all({
        url: Config.String("DATABASE_URL"),
        pool: Config.Int("DATABASE_POOL_SIZE").pipe(Config.withDefault(10)),
    }),
    features: Config.all({
        enableBeta: Config.Boolean("ENABLE_BETA").pipe(Config.withDefault(false)),
        maxUploadSize: Config.Int("MAX_UPLOAD_SIZE").pipe(Config.withDefault(10485760)),
    }),
})
```

Use `Config.nested` to compose lookup path prefixes.

## Log Level Configuration

`LogLevel` values are plain string literals: `"Fatal"`, `"Error"`, `"Warn"`, `"Info"`,
`"Debug"`, `"Trace"`, `"All"`, `"None"`.

The minimum level is a context reference, so it is set with a layer:

```typescript
import { Config, Effect, Layer, References } from "effect"

const LogLevelLive = Layer.unwrap(
    Effect.gen(function* () {
        const level = yield* Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info"))
        return Layer.succeed(References.MinimumLogLevel, level)
    })
)
```

`Config.LogLevel(name)` parses and validates the literal for you, with no manual lookup table.

For production JSON logging, `Logger.layer` defines the active logger set. Include
`Logger.tracerLogger` to emit log events to the tracer:

```typescript
import { Logger } from "effect"

const JsonLoggerLive = Logger.layer([Logger.consoleJson, Logger.tracerLogger])

// Pretty console output for development
const PrettyLoggerLive = Logger.layer([Logger.consolePretty(), Logger.tracerLogger])
```

Omit `tracerLogger` only when trace log events should stay disabled.

Other configurable context values live in `References` as well. `References.CurrentLogLevel`,
`References.CurrentLogAnnotations`, and `References.TracerEnabled` are all set with
`Effect.provideService` or a `Layer.succeed`.

## Combining Observability

```typescript
const processOrder = Effect.fn("OrderService.process")(function* (input: OrderInput) {
    const startTime = yield* Clock.currentTimeMillis

    // Annotate span
    yield* Effect.annotateCurrentSpan("orderId", input.orderId)
    yield* Effect.annotateCurrentSpan("userId", input.userId)

    // Log start
    yield* Effect.log("Processing order", { orderId: input.orderId })

    const result = yield* process(input).pipe(
        Effect.tap(() =>
            Effect.gen(function* () {
                const duration = (yield* Clock.currentTimeMillis) - startTime

                // Record metrics
                yield* Metric.update(orderProcessingDuration, duration)
                yield* Metric.update(ordersProcessed, 1)

                // Log completion
                yield* Effect.log("Order processed", {
                    orderId: input.orderId,
                    durationMs: duration,
                })
            })
        ),
        Effect.tapError((err) =>
            Effect.gen(function* () {
                yield* Metric.update(ordersFailed, 1)
                yield* Effect.logError("Order processing failed", {
                    orderId: input.orderId,
                    error: err._tag,
                })
            })
        ),
    )

    return result
})
```

`Clock.currentTimeMillis` is yieldable directly.
