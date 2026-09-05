# pi-subagent

A [Pi Coding Agent](https://pi.dev) extension for delegating work to child
agents.

One tool call takes a batch of tasks. Each task may name the tasks it needs,
which both gates it until they settle and prepends their output into its
prompt. No edges means plain parallel.

Children are read-only, and you pick their model and thinking effort rather
than letting the orchestrating model guess.

**Under construction.** The package is scaffolded; the manager is not written
yet. Nothing here is installable.

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
