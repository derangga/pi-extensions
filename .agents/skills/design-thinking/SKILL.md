---
name: design-thinking
description: The design pass that runs before code — name the shapes, draw the call graph, annotate A/E/R, then emit it. Use before any change that adds or changes behaviour; for interface work reach references/design-graph.md.
---

# Design Thinking

```
X → Graph → Effect<A, E, R>
│              │   │  │  │
│              │   │  │  └─ what each node needs      (§5)
│              │   │  └──── where the graph breaks    (§4)
│              │   └─────── what flows through nodes  (§2)
│              │
│              └─ nodes = functions, edges = data flow
│
└─ the problem: what you're trying to build

§1  Shapes       the nouns: records, IDs, variants, errors
§2  A            happy path as call graph
§3  Cardinality  one-shot (Effect) or many (Stream)
§4  E            break points: retry, escape, die
§5  R            dependencies: compile-time proof
§6  Boundary     Schema: unknown → trusted at edges
§7  Behavior     .pipe() wraps without changing the graph
§8  Scope        acquire/release tied to lifecycle
§9  Test         swap R, same graph shape
§10 Code         gen body = A, .pipe() = E
```

Read the problem. Draw the data flow as a call graph. Write code that IS the
graph. If the code doesn't match the graph, something is wrong.

## How much of this to run

The ten sections are not equal. **Four carry the method** — run them on every
change that writes code, however small:

| §   | always run               | because                                                              |
| --- | ------------------------ | -------------------------------------------------------------------- |
| §4  | **E** — retry/escape/die | the decision code skips by default; everything becomes catch-and-log |
| §5  | **R** — what it needs    | the difference between a dependency and a hidden one                 |
| §9  | **swap R**               | you can see whether it is testable before writing a test             |
| §10 | **gen = A, pipe = E**    | the only one you can check by looking at the finished code           |

Two are prerequisites — you cannot annotate a graph you have not drawn, but
drawing it is rarely where the insight is. Do them fast and do not linger:

- **§1 shapes** and **§2 A** — usually already answered by the existing code.

Four fire on a trigger. No trigger, skip it:

| §   | fires when                                       |
| --- | ------------------------------------------------ |
| §3  | a node might emit more than once, or over time   |
| §6  | untrusted data crosses into the graph            |
| §7  | a node needs retry, timeout, tracing, or caching |
| §8  | a node acquires something that must be released  |

**This is a priority order, not permission to skip.** Skipping one of those four
is a claim that its trigger is absent — if you cannot say why §6 does not apply,
it applies.

### Depth per change

| the change                                           | run                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| introduces shapes or failure modes that didn't exist | §1–§2 to draw it, the four to annotate it, plus triggers                |
| only adds call sites for shapes that already exist   | the four — §1–§2 are already answered by the code                       |
| doesn't touch data flow, only what a person is shown | `references/design-graph.md` — the same method, turned on the interface |

Torn between two depths → run the deeper one. The pass is cheap; a graph
discovered halfway through the code is not.

A host project may map these onto its own triage vocabulary; the mapping belongs
in that project's instructions, not here.

## 1. Name the shapes

What are the things? Before drawing a graph, define the domain language.

- **Records** — entities that flow through nodes. A User, a Product, an Order.
- **IDs** — identity of things. Branded, constrained, never a bare string.
- **Variants** — internal state transitions. A step is Continue or Finished. A
  status is Pending, Active, or Cancelled.
- **Errors** — named failure modes. Not strings. Tagged, structured, carrying
  context.

These are the nouns. The graph is the verbs. You cannot draw the graph until you
know what flows through it.

## 2. Think A first

Map the happy path as a call graph before writing any code. What goes in, what
comes out, what transforms happen in between. This graph IS the program
structure — the code follows it, not the other way round.

## 3. One or many?

Is each node one-shot or a flow?

- **One value** — the node runs, produces A, done. This is `Effect`.
- **Many values over time** — the node emits A repeatedly. Events,
  subscriptions, paginated pulls. This is `Stream`.
- **Time-bounded** — the result is valid for a window. Cache it. Deduplicate
  concurrent lookups.

Same three channels in all cases, different cardinality. Mark it on the graph so
the code matches.

## 4. Think E second

Mark where the graph can break. Each break point is one of three things:

- **Retry** — transient failure, try again. Network timeout, rate limit,
  connection reset.
- **Escape hatch** — recoverable, return an alternative. Fallback value, cached
  result, default.
- **Die** — a bug in your own code, not a failure of the world. The program
  assumed something that turned out false. NOT a domain error.

Errors are VALUES in the E channel until you truly cannot handle them. They flow
through the graph like data, and you decide at each node: retry, escape, or let
it propagate. Only `die` when the program's assumptions are violated.

## 5. Think R third

Mark what each node needs to exist. "We cannot do X if we don't have Y."

R is compile-time proof that dependencies are satisfied. Every node declares
what it requires — a connection, a config value, an HTTP client. R shrinks as
layers are provided; when R is `never`, the program can run. A missing service
is a type error that names it.

## 6. Trust at boundary

Where does untrusted data enter the graph? HTTP responses, file reads,
environment variables, user input, third-party payloads.

Schema converts `unknown → trusted` at the edges. One definition = type +
validator + transformer. Define it once, use it everywhere.

Trust nothing at the boundary. Trust everything inside. The boundary is the only
place you parse; after that the types guarantee shape.

## 7. Layer behavior

What wraps a node without changing what it does? Retry policies, timeouts,
spans, logging, caching.

These wrap via `.pipe()` WITHOUT changing the core graph. The happy path stays
readable — no wading through retry config to find what the function does. Each
wrapper can be added or removed on its own: the graph says WHAT happens, the
wrappers say HOW it behaves under pressure.

## 8. Scope resources

What nodes acquire something that must be released? Connections, file handles,
subscriptions, listeners, child processes.

Acquire/release is a type guarantee. If a node opens it, scope closes it — even
on error, even on interrupt. Cleanup is structural, not a TODO someone
remembers.

## 9. Swap R to prove it

The call graph doesn't change between production and tests. Only R changes.

Same graph shape, same A flowing through, same E possible, different layer
behind R. If the graph can't run with a test R, the design has hidden
dependencies. If you have to mock the world to test one node, the node is doing
too much.

This is the payoff of separating A, E and R — you prove the graph correct by
swapping what sits behind R.

## 10. gen is A, pipe is E

§2 and §4 map directly onto code structure:

- **`Effect.gen` body** — the happy path. Every `yield*` is an A flowing through
  the graph. No error handling inside.
- **`.pipe()` after gen** — the complete E enumeration. Read the actual E type of
  every yielded effect before writing it; the pipe catches, retries or
  transforms every E the body can produce.

This is not a stylistic preference. Error handling inside the gen body tangles
the A path and the E path, and the happy path stops being readable. The gen body
IS the call graph from §2; the pipe IS the error annotation from §4.

Two details are Effect mechanics rather than method, and live wherever the
project keeps its Effect reference: how each layer turns the errors it received
into its own, and the one case where error handling does belong inside the gen
body (two yields in the same body needing opposite treatment, where a single
outer pipe cannot tell which one failed). This section fixes only _why_ the
split exists.

## Emit the graph before the code

The answers get **written into the reply** before any code exists. A graph that
was only thought is unverifiable — neither you nor the reader can tell a design
pass from a claim of one.

Notation: steps at the left margin prefixed `->`, nodes indented beneath the step
they belong to, `R:` and `E:` riding the node line they annotate. Horizontal
chains (`F1(A) -> F2(A) -> F3(A)`) are banned — they wrap badly in a terminal.
The graph grows down the page, not across it.

```
shapes: OrderId (branded), Order, OrderNotFound, TransportError

-> load order list
  -> HttpClient.get("/orders")   R: HttpClient   E: TransportError -> retry x2
  -> Schema.decode(OrderPage)                    E: ParseError -> die
-> render
  -> list surface                                E: OrderNotFound -> empty state
```

The sketch is what the first failing test asserts against — the `E:` column
enumerates the failure tests, the shapes give the decode tests. It lives in the
reply only; never commit it as a comment header, where it rots the moment the
code moves.

### Call graphs of existing code

**One notation, two uses.** The same `->` sketch traces code that already
exists — architecture summaries, project overviews, explaining a flow. Keep the
`R:` and `E:` columns: a bare tree of names says only what calls what, while the
annotations say what each node needs and how it breaks. That is the whole
difference between a diagram and a design.

Production and tests get separate sections when they differ — the contrast is §9
made visible, the same graph shape with a different R behind it:

```
production

-> handle request               R: HttpServer
  -> OrderService.place         R: Database   E: PersistenceError -> 500
    -> Database.transaction     R: Connection E: SqlError -> retry x3
  -> Notifier.enqueue           R: Queue      E: QueueUnavailable -> escape, log
```

```
tests — same graph, R swapped

-> handle request               R: HttpServer
  -> OrderService.place         R: Database.layerMemory
    -> Database.transaction     R: Connection.layerTest
  -> Notifier.enqueue           R: Queue.layerMemory
```

If the two graphs differ by anything except what sits behind `R:`, the design
has a hidden dependency — that is §9 failing, reported as a drawing.

Plain text only, no rendered diagrams.

## The Pipeline

```
PROBLEM
  -> "What are the shapes?"                         -> define the domain language
  -> "What is the happy path?"                      -> draw the call graph (A)
  -> "Is each node one-shot or a flow?"             -> mark cardinality
  -> "Where can it break?"                          -> annotate errors on the graph (E)
  -> "What does each node need?"                    -> annotate requirements on the graph (R)
  -> "Where does untrusted data enter?"             -> Schema at graph boundaries
  -> "What wraps nodes without changing them?"      -> wrap it, don't inline it
  -> "What resources need cleanup?"                 -> scope lifecycle
  -> "Can I swap R and the graph still works?"      -> verify with test layers
  -> "Does my code separate A from E structurally?" -> gen body = A, pipe = E
  -> CODE                                           -> the code IS the graph
```

**If the code doesn't match the call graph, the implementation is wrong.**
