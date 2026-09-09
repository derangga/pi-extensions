import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool identity. The name "todo" is the tool the model calls; it is free of
// conflicts with Pi's built-in tools but clashes with @juicesharp/rpiv-todo
// (same name), so the two extensions are not co-installable.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns
 * this shape under `details`; replay reads the latest one from the branch to
 * reconstruct module state. Field names are the replay contract.
 */
export interface TaskDetails {
  action: TaskAction;
  params: TodoParams;
  tasks: Task[];
  nextId: number;
  error?: string;
}

/**
 * Input bag the reducer accepts. Typed against the schema's static shape so
 * the host's validated object passes through without casts at the boundary.
 */
export type TaskMutationParams = TodoParams;

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy, so the wording is part of the tool's behavior, not decoration.
// ---------------------------------------------------------------------------

const ACTION_DESCRIPTION =
  "What to do: create (new task), update (change status/fields/dependencies), list (tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all).";

export const TodoParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("list"),
      Type.Literal("get"),
      Type.Literal("delete"),
      Type.Literal("clear"),
    ],
    { description: ACTION_DESCRIPTION },
  ),
  subject: Type.Optional(
    Type.String({
      description:
        "Task subject line (required for create). Short and imperative, e.g. 'Research existing tool'.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Long-form task description",
    }),
  ),
  activeForm: Type.Optional(
    Type.String({
      description:
        "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("deleted"),
      ],
      {
        description:
          "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
      },
    ),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Initial blockedBy ids (create only)",
    }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Task ids to add to blockedBy (update only, additive merge)",
    }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Task ids to remove from blockedBy (update only, additive removal)",
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: "Task id (required for update, get, delete)",
    }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({
      description:
        "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
    }),
  ),
});

export type TodoParams = {
  action: TaskAction;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  id?: number;
  includeDeleted?: boolean;
};
