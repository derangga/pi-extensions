# pi-subagent

A [Pi Coding Agent](https://pi.dev) extension for delegating work to child
agents.

One tool call takes a batch of tasks. Each task may name the tasks it needs,
which both gates it until they settle and prepends their output into its
prompt. No edges means plain parallel.

Children are read-only, and you pick their model and thinking effort rather
than letting the orchestrating model guess.

**Under construction.** Settings work; the manager that spawns children does
not exist yet.

## Settings

`/subagent` opens a panel with five rows.

| Row | What it does |
|---|---|
| Model | `inherit` follows the parent session, or pick one concrete model that every child runs on |
| Thinking effort | `inherit` leaves the per-task choice in charge, or pin a level. The list is only what the resolved model accepts |
| Concurrency | How many children run at once |
| Max turns | Turn budget per child before it is asked to wrap up |
| Max tasks | Most children one call may spawn, 1 to 16. A call over the cap is refused before any child starts |

Concurrency and max tasks answer different questions. Concurrency is how many
children run at the same time, so it moves wall time and memory. Max tasks is
how many run at all, so it is the one that bounds what a batch costs.

Changes apply and save as you make them, so closing the panel saves nothing
further. Settings live in `pi-subagent.json` under Pi's agent directory, and
the panel prints the path because hand-editing reaches anything the rows do
not offer. `PI_SUBAGENT_CONFIG` overrides the location.

A settings file that cannot be read or parsed falls back to defaults and says
so, rather than failing the extension load. A single out-of-range field is
dropped on its own, leaving the rest of the file in force.

## Dependencies

One runtime dependency, `effect`. It carries the concurrency, the structured
cancellation and the resource scoping this package is built on: a run is a set
of fibers over a dependency graph, each child session is an acquire/release
pair, and a cancelled run has to tear down every child without leaking a
session. That is the whole of the manager, not a convenience on top of it.

Pi and `typebox` are peers. Tool schemas are typebox because that is what
`registerTool` takes.

## License

MIT. See [LICENSE](./LICENSE).
