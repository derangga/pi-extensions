# pi-todo-agent

Pi extension. A todo list the model manages through a `todo` tool, rendered as a live overlay above the editor. Zero runtime dependencies.

The model plans multi-step work as tasks, marks each one in progress and completed as it works, and you watch the list update in real time. State survives compaction and reloads, and every session gets its own list.

## Install

```sh
npm install pi-todo-agent
```

The package declares no `dependencies`. It needs three host-provided peers, which any Pi install already ships: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## The `todo` tool

```sh
todo({ action: "create", subject: "Research existing tool", blockedBy: [] })
todo({ action: "update", id: 1, status: "in_progress", activeForm: "researching" })
todo({ action: "list" })
todo({ action: "get", id: 1 })
todo({ action: "delete", id: 1 })
todo({ action: "clear" })
```

Statuses are a 4-state machine: `pending → in_progress → completed`, plus `deleted` as a tombstone. Completed tasks never reopen; `clear` resets the list and the id counter.

| Action | Required params | Notes |
| --- | --- | --- |
| `create` | `subject` | Adds a task in `pending`. Optional `description`, `activeForm`, `blockedBy`. |
| `update` | `id` + one mutable field | Changes `status`, `subject`, `description`, `activeForm`, or the dependency set. |
| `list` | — | All tasks; filter by `status`, pass `includeDeleted` to see tombstones. |
| `get` | `id` | One task with its `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task; the id is never reused. |
| `clear` | — | Drops every task and resets ids to 1. |

Dependencies: `blockedBy` holds ids a task waits on. Rejected calls leave the list untouched: unknown ids, already-deleted ids, self-blocks, and dependency cycles are all validated before the state changes. `update` merges `addBlockedBy`/`removeBlockedBy` additively.

Invalid transitions are rejected with the list unchanged, and an `update` that changes nothing reports "No change" so the model does not re-issue it in a loop.

When a mutation completes the last visible task, the tool result prints the full final list ("All N tasks done"), so a record survives in the transcript after the overlay fades.

## The overlay

A `Todos (2/5)` widget renders above the editor while any task is visible. It caps at 12 content rows, dropping completed rows first and summarizing the rest as `+N more`. When Pi's tool output is expanded, every row shows. Completed rows fade out when the next turn starts, and the widget hides itself entirely when the list is empty. Expanding the list again is as simple as creating another task.

## Sessions

State is partitioned by session id. Detached or child sessions get their own list instead of clobbering yours. On `session_start`, `session_compact`, and `session_tree`, the extension replays the latest `todo` snapshot from the conversation branch, so the list survives compaction and `/reload`. On shutdown the session's slot is evicted.

## Configuration

None. The prompt guidance and the overlay row budget are hardcoded constants in the source. This is a deliberate trade for keeping the package at zero dependencies.

## Not compatible with `@juicesharp/rpiv-todo`

Both packages register a tool named `todo`. Install one or the other, not both.

## License

MIT
