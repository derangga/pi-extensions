# Effect Atom Patterns

Effect Atom is a reactive state management library that integrates with Effect. It provides atoms (reactive containers), automatic dependency tracking, and seamless React integration.

> **Effect v4.** The React package is **`@effect/atom-react`**. `Atom` and `AsyncResult`
> are imported from **`effect/unstable/reactivity`**.

## Core Concepts

- **Atoms**: Reactive state containers with automatic dependency tracking
- **AsyncResult**: Handles async and effectful computations with initial, success, and failure states
- **Finalizers**: Built in cleanup for resources and event listeners
- **Families**: Dynamic atom creation for per entity state

## Imports at a Glance

```typescript
// Core atom and result modules, from effect
import { Atom, AsyncResult } from "effect/unstable/reactivity"

// React bindings, from the framework package
import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
```

Sibling packages `@effect/atom-solid` and `@effect/atom-vue` follow the same split.

## Creating Atoms

### Basic Atoms

```typescript
import { Atom } from "effect/unstable/reactivity"

// Simple value atom
const countAtom = Atom.make(0)

// With keepAlive, persists when no components subscribe
const persistentCountAtom = Atom.make(0).pipe(Atom.keepAlive)
```

**Rule:** Use `Atom.keepAlive` for global state that should persist across component unmounts.
Define atoms outside components.

### Derived Atoms

```typescript
const countAtom = Atom.make(0)

// Derived using get function
const doubleCountAtom = Atom.make((get) => get(countAtom) * 2)

// Derived using Atom.map
const tripleCountAtom = Atom.map(countAtom, (count) => count * 3)
```

### Atoms with Side Effects

```typescript
// Track window scroll position
const scrollYAtom = Atom.make((get) => {
    const onScroll = () => get.setSelf(window.scrollY)

    window.addEventListener("scroll", onScroll)
    get.addFinalizer(() => window.removeEventListener("scroll", onScroll))

    return window.scrollY
}).pipe(Atom.keepAlive)
```

**Critical:**
- Use `get.setSelf` to update the atom own value
- Always add finalizers with `get.addFinalizer()` to clean up side effects
- Finalizers run when the atom is rebuilt or disposed

### Atom.transform for Self-Updating Derived State

```typescript
const resolvedThemeAtom = Atom.transform(themeAtom, (get) => {
    const theme = get(themeAtom)
    if (theme !== "system") return theme

    const matcher = window.matchMedia("(prefers-color-scheme: dark)")

    const onChange = () => get.setSelf(matcher.matches ? "dark" : "light")

    matcher.addEventListener("change", onChange)
    get.addFinalizer(() => matcher.removeEventListener("change", onChange))

    return matcher.matches ? "dark" : "light"
})
```

## Atom Families

Use `Atom.family` for per entity state:

```typescript
import { Atom } from "effect/unstable/reactivity"

// Create a family of atoms, one per channelId
const replyToMessageAtomFamily = Atom.family((channelId: string) =>
    Atom.make<string | null>(null).pipe(Atom.keepAlive)
)

// Modal state family
type ModalType = "settings" | "confirm" | "create"

interface ModalState {
    type: ModalType
    isOpen: boolean
    metadata?: Record<string, unknown>
}

const modalAtomFamily = Atom.family((type: ModalType) =>
    Atom.make<ModalState>({
        type,
        isOpen: false,
        metadata: undefined,
    }).pipe(Atom.keepAlive)
)
```

**Use families for:**
- Per resource state (users, channels, documents)
- Modal instances
- Form state per entity
- Any parameterized state

## React Integration

### Reading Atom Values

```tsx
import { useAtomValue } from "@effect/atom-react"

function Counter() {
    const count = useAtomValue(countAtom)
    return <span>{count}</span>
}
```

### Updating Atom Values

```tsx
import { useAtomSet } from "@effect/atom-react"

function IncrementButton() {
    const setCount = useAtomSet(countAtom)
    return (
        <button onClick={() => setCount((c) => c + 1)}>
            Increment
        </button>
    )
}
```

### Reading and Writing Together

```tsx
import { useAtom } from "@effect/atom-react"

function CounterControl() {
    const [count, setCount] = useAtom(countAtom)
    return (
        <div>
            <span>{count}</span>
            <button onClick={() => setCount(count + 1)}>+1</button>
        </div>
    )
}
```

### Mounting Side-Effect Atoms

Use `useAtomMount` to activate atoms without reading their value:

```tsx
import { useAtomMount } from "@effect/atom-react"

function App() {
    // Activate side effects without subscribing to value
    useAtomMount(keyboardShortcutsAtom)
    useAtomMount(presenceTrackingAtom)
    useAtomMount(themeApplierAtom)

    return <>{children}</>
}
```

## React Mutation Patterns

### Deriving Loading State from result.waiting

When using mutation atoms with `mode: "promise"`, derive loading state from `result.waiting` instead of managing separate `useState`:

```tsx
const [result, mutate] = useAtom(myMutation, { mode: "promise" })
const isLoading = result.waiting // No useState needed

const handleSubmit = async () => {
    try {
        await mutate(payload)
        onSuccess?.()
    } catch (err) {
        showError(err)
    }
    // No finally block, result.waiting updates automatically
}

<Button disabled={isLoading}>{isLoading ? "Loading..." : "Submit"}</Button>
```

**Why this is preferred:**
- Single source of truth, loading state lives on the AsyncResult
- No manual state resets
- Automatically synchronized with the mutation lifecycle

### Dialog Components Own Their Mutations

Move mutation logic INTO dialog components rather than keeping it in page components.

**Dialog owns:** mutation hook, loading state, toast notifications
**Parent provides:** data props, `onSuccess` callback

```tsx
// CORRECT, dialog owns its mutation
function ArchivePaywallDialog({
    paywall,
    onSuccess,
}: {
    paywall: Paywall
    onSuccess?: () => void
}) {
    const [result, archivePaywall] = useAtom(archivePaywallMutation, { mode: "promise" })
    const isLoading = result.waiting

    const handleArchive = async () => {
        try {
            await archivePaywall({ paywallId: paywall.id })
            toast.success("Paywall archived")
            onSuccess?.()
        } catch (err) {
            toast.error("Failed to archive paywall")
        }
    }

    return (
        <AlertDialog>
            <AlertDialogContent>
                <AlertDialogTitle>Archive "{paywall.name}"?</AlertDialogTitle>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <Button onClick={handleArchive} disabled={isLoading}>
                        {isLoading ? "Archiving..." : "Archive"}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}

// Parent just passes data and reacts to success
function PaywallPage() {
    return <ArchivePaywallDialog paywall={paywall} onSuccess={() => navigate("/paywalls")} />
}
```

### reactivityKeys for Cache Invalidation

Mutations can specify `reactivityKeys` to automatically invalidate queries that share the same keys, with no manual `refresh()` calls needed.

`reactivityKeys` lives on `AtomRuntime.fn`, so both atoms hang off a runtime built from the
layer that provides your services plus `Reactivity.layer`:

```typescript
import { Effect, Layer } from "effect"
import { Atom, Reactivity } from "effect/unstable/reactivity"

const runtime = Atom.runtime(Layer.mergeAll(PaywallService.layer, Reactivity.layer))

// Query atom. Reactivity.stream re runs the effect when the keys are invalidated
const paywallsAtom = runtime.atom(
    Reactivity.stream(
        Effect.gen(function* () {
            const paywalls = yield* PaywallService
            return yield* paywalls.list()
        }),
        ["paywalls"],
    )
)

// Mutation atom. reactivityKeys is an option on runtime.fn
const archivePaywallMutation = runtime.fn(
    (payload: { paywallId: string }) =>
        Effect.gen(function* () {
            const paywalls = yield* PaywallService
            yield* paywalls.archive(payload.paywallId)
        }),
    { reactivityKeys: ["paywalls"] },
)
```

**Rules:**
- Both the mutation and query must share at least one matching key
- After the mutation succeeds, all atoms with matching keys re execute
- This pattern takes the place of manual calls such as `refreshPaywalls()` after mutations
- `Atom.make` has no `reactivityKeys` option. Its options are `{ initialValue, uninterruptible }`,
  and it takes an `Effect` or a `Stream`, never a function that returns one

## Working with Effects and AsyncResult

### Effectful Atoms Return AsyncResult

```typescript
import { Atom, AsyncResult } from "effect/unstable/reactivity"
import { Effect } from "effect"

const userAtom = Atom.make(
    Effect.gen(function* () {
        const response = yield* fetchUser()
        return response
    })
) // Type: Atom<AsyncResult<User, Error>>
```

`AsyncResult` has three states, `Initial`, `Success`, and `Failure`, plus a `waiting` flag that is
orthogonal to all three. A `Success` can have `waiting: true` while it refreshes.

### Rendering with AsyncResult.match

Use `AsyncResult.match` for the three states:

```tsx
import { AsyncResult } from "effect/unstable/reactivity"
import { useAtomValue } from "@effect/atom-react"

function UserProfile() {
    const userResult = useAtomValue(userAtom)

    return AsyncResult.match(userResult, {
        onInitial: () => <div>Loading...</div>,
        onFailure: (failure) => <div>Error: {String(failure.cause)}</div>,
        onSuccess: (success) => <div>Hello, {success.value.name}!</div>,
    })
}
```

Each handler receives the **variant**, not the bare value, so success is `success.value`.

### Typed Errors with AsyncResult.matchWithError

`matchWithError` splits a failure into a typed error and a defect. Branch on `_tag` inside
`onError`:

```tsx
function ResourceEmbed({ url }: { url: string }) {
    const resourceResult = useAtomValue(resourceAtom)

    return AsyncResult.matchWithError(resourceResult, {
        onInitial: () => <Skeleton />,
        onError: (error) => {
            switch (error._tag) {
                case "NotFoundError":
                    return <ErrorCard message={error.message} />
                case "UnauthorizedError":
                    return <ConnectPrompt provider="GitHub" />
                case "RateLimitError":
                    return <RetryCard retryAfter={error.retryAfter} />
                default:
                    return <ErrorCard message="Something went wrong" />
            }
        },
        onDefect: (defect) => <ErrorCard message="Unexpected error" />,
        onSuccess: (success) => <ResourceCard data={success.value} />,
    })
}
```

A `switch` on `_tag` narrows each branch. The `default` case handles remaining errors. An
unhandled state is a **compile error**.

Explicit `_tag` checks also work outside match helpers:

```tsx
function StatusBadge() {
    const result = useAtomValue(resourceAtom)
    if (result._tag === "Initial") return <Skeleton />
    if (result._tag === "Failure") return <ErrorCard message={String(result.cause)} />
    return <span>{result.value.name}</span>
}
```

### AsyncResult API

| API | Purpose |
|--------|---------|
| `AsyncResult.match(r, {...})` | Exhaustive 3 case match: `onInitial` / `onFailure` / `onSuccess` |
| `AsyncResult.matchWithError(r, {...})` | Splits failure into `onError` (typed) and `onDefect` |
| `AsyncResult.getOrElse(r, fn)` | Extract the value, or a fallback |
| `AsyncResult.value(r)` | `Option<A>` of the current value |
| `AsyncResult.isInitial(r)` | Guard for the initial state |
| `AsyncResult.isSuccess(r)` | Guard for success (narrows to `Success<A, E>`) |
| `AsyncResult.isFailure(r)` | Guard for failure (narrows to `Failure<A, E>`) |
| `AsyncResult.isWaiting(r)` | `true` while an async computation or refresh is in flight |
| `result.waiting` | The same flag, read directly off any variant |

### Extracting Values with getOrElse

For non rendering use cases:

```typescript
function useRepositories() {
    const reposResult = useAtomValue(repositoriesAtom)

    // Extract array or empty fallback
    return AsyncResult.getOrElse(reposResult, () => [])
}
```

### Guards for Early Returns

When a component only cares about the success path:

```tsx
function UserName() {
    const userResult = useAtomValue(userAtom)

    if (!AsyncResult.isSuccess(userResult)) return <span>Loading...</span>
    return <span>{userResult.value.name}</span>
}
```

### When to Use Each Pattern

| Pattern | Use Case |
|---------|----------|
| `AsyncResult.match` | UI rendering, all three states, no typed error branching |
| `AsyncResult.matchWithError` | APIs with tagged errors (HttpApi, RPC) |
| `AsyncResult.getOrElse` | Extracting values with a fallback |
| `AsyncResult.isSuccess` guard | Early return when only success matters |

### Accessing Results in Derived Atoms

```typescript
const userProfileAtom = Atom.make(
    Effect.fnUntraced(function* (get: Atom.AtomContext) {
        // Unwrap AsyncResult to get the value (waits for success)
        const user = yield* get.result(userAtom)
        const posts = yield* fetchUserPosts(user.id)
        return { user, posts }
    })
)
```

The context type is `Atom.AtomContext`.

## Batching Updates

`Atom.batch` takes a **synchronous** callback and coalesces the writes made inside it, rebuilding
stale nodes and notifying listeners once at the end. The writes have to be synchronous, which
means the registry's own `set` and `update`:

```typescript
import * as React from "react"
import { RegistryContext } from "@effect/atom-react"
import { Atom } from "effect/unstable/reactivity"

const useOpenModal = () => {
    const registry = React.useContext(RegistryContext)

    return (type: ModalType, metadata?: Record<string, unknown>) => {
        Atom.batch(() => {
            registry.update(modalAtomFamily(type), (state) => ({
                ...state,
                isOpen: true,
                metadata,
            }))
            registry.set(lastOpenedAtom, type)
        })
    }
}
```

`Atom.set` and `Atom.update` are the **Effect returning** variants: they produce
`Effect<void, never, AtomRegistry>` and do nothing until run. Calling one inside an `Atom.batch`
callback builds an Effect and throws it away, so the update silently never happens, and
TypeScript will not flag it. Inside a batch, reach for `registry.set` / `registry.update`, which
return `void`.

## localStorage Persistence

```typescript
import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Atom } from "effect/unstable/reactivity"
import { Schema } from "effect"

// Create runtime with localStorage
const localStorageRuntime = Atom.runtime(BrowserKeyValueStore.layerLocalStorage)

// Persisted atom with schema validation
const themeAtom = Atom.kvs({
    runtime: localStorageRuntime,
    key: "app-theme",
    schema: Schema.Literals(["dark", "light", "system"]),
    defaultValue: () => "system" as const,
})
```

`Schema.Literals` takes one array argument. `Schema.Literal` takes exactly one value.

## Anti-Patterns

### FORBIDDEN: Creating Atoms Inside Components

```tsx
// WRONG, creates new atom on every render
function Counter() {
    const countAtom = Atom.make(0) // New atom each render!
    const count = useAtomValue(countAtom)
    return <div>{count}</div>
}

// CORRECT, define atoms outside components
const countAtom = Atom.make(0)

function Counter() {
    const count = useAtomValue(countAtom)
    return <div>{count}</div>
}
```

### FORBIDDEN: Imperative Updates from React Components

```tsx
// WRONG, twice over: Atom.update returns an unrun Effect, so nothing happens at all,
// and even a real write here bypasses the hook that would re-render the component
export const openModal = (type: string) => {
    Atom.batch(() => {
        Atom.update(modalAtomFamily(type), (s) => ({ ...s, isOpen: true }))
    })
}

function Component() {
    return <button onClick={() => openModal("settings")}>Open</button>
}

// CORRECT, use hooks for React integration
export const useModal = (type: string) => {
    const state = useAtomValue(modalAtomFamily(type))
    const setState = useAtomSet(modalAtomFamily(type))

    const open = useCallback(() => {
        setState((prev) => ({ ...prev, isOpen: true }))
    }, [setState])

    const close = useCallback(() => {
        setState((prev) => ({ ...prev, isOpen: false }))
    }, [setState])

    return { isOpen: state.isOpen, open, close }
}
```

**When imperative updates ARE acceptable:**
- Event listeners outside React (keyboard shortcuts)
- Effects running on atom changes
- Non UI state (analytics, logging)

### FORBIDDEN: Missing Finalizers

```typescript
// WRONG, memory leak!
const scrollAtom = Atom.make((get) => {
    const onScroll = () => get.setSelf(window.scrollY)
    window.addEventListener("scroll", onScroll)
    return window.scrollY
})

// CORRECT, cleanup registered
const scrollAtom = Atom.make((get) => {
    const onScroll = () => get.setSelf(window.scrollY)
    window.addEventListener("scroll", onScroll)
    get.addFinalizer(() => window.removeEventListener("scroll", onScroll))
    return window.scrollY
})
```

### FORBIDDEN: Missing keepAlive for Global State

```typescript
// WRONG, state resets when component unmounts
export const modalStateAtom = Atom.make({ isOpen: false })

// CORRECT, state persists
export const modalStateAtom = Atom.make({ isOpen: false }).pipe(Atom.keepAlive)
```

### FORBIDDEN: Ignoring AsyncResult States

```tsx
// WRONG, does not handle loading and error states
const userResult = useAtomValue(userAtom)
return <div>Hello, {userResult.name}</div> // Type error!

// CORRECT, match all states
const userResult = useAtomValue(userAtom)
return AsyncResult.match(userResult, {
    onInitial: () => <div>Loading...</div>,
    onFailure: (failure) => <div>Error: {String(failure.cause)}</div>,
    onSuccess: (success) => <div>Hello, {success.value.name}</div>,
})
```

### FORBIDDEN: Updating State During Render

```tsx
// WRONG, side effect during render
function Component() {
    const count = useAtomValue(countAtom)
    Atom.set(countAtom, count + 1) // Never do this!
    return <div>{count}</div>
}

// CORRECT, use effects or event handlers
function Component() {
    const count = useAtomValue(countAtom)
    const setCount = useAtomSet(countAtom)

    useEffect(() => {
        setCount((c) => c + 1)
    }, [])

    return <div>{count}</div>
}
```

### FORBIDDEN: useState for Mutation Loading State

```typescript
// WRONG, manual loading state management
function DeleteDialog({ id }: { id: string }) {
    const [, deleteThing] = useAtom(deleteMutation, { mode: "promise" })
    const [isLoading, setIsLoading] = useState(false)

    const handleDelete = async () => {
        setIsLoading(true)
        try {
            await deleteThing({ id })
        } finally {
            setIsLoading(false) // Unnecessary boilerplate
        }
    }
}

// CORRECT, derive from result.waiting
function DeleteDialog({ id }: { id: string }) {
    const [result, deleteThing] = useAtom(deleteMutation, { mode: "promise" })
    const isLoading = result.waiting

    const handleDelete = async () => {
        try {
            await deleteThing({ id })
        } catch (err) {
            showError(err)
        }
    }
}
```

### FORBIDDEN: Mutations in Parent Components

```tsx
// WRONG, parent manages the mutation
function PaywallPage() {
    const [result, archivePaywall] = useAtom(archivePaywallMutation, { mode: "promise" })

    const handleArchive = async () => {
        await archivePaywall({ paywallId })
        toast.success("Archived")
    }

    return <ConfirmDialog onConfirm={handleArchive} loading={result.waiting} />
}

// CORRECT, dialog owns its mutation
function PaywallPage() {
    return <ArchivePaywallDialog paywall={paywall} onSuccess={() => navigate("/paywalls")} />
}
// ArchivePaywallDialog internally uses useAtom(archivePaywallMutation, { mode: "promise" })
```

## Performance Tips

### Selective Re-rendering

```typescript
// WRONG, subscribes to entire state
const state = useAtomValue(appStateAtom)
const userName = state.user.name

// CORRECT, derive focused atom
const userNameAtom = Atom.map(appStateAtom, (state) => state.user.name)
const userName = useAtomValue(userNameAtom)
```

### When to Use keepAlive

Use `Atom.keepAlive` for:
- Global application state
- Modal and dialog state
- User preferences
- Authentication state
- Frequently accessed derived state

Skip `keepAlive` for:
- Component local state that should reset
- Temporary form state
- State tied to component lifecycle
