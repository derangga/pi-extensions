import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. A closed tagged union — adding a variant requires
 * extending this union AND the response envelope's format switch, which the
 * compiler enforces via exhaustiveness.
 *
 * `error` carries the message in-band so callers pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus; changed: boolean }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

const MUTABLE_FIELDS_MESSAGE =
  "update requires at least one mutable field: subject, description, activeForm, status, addBlockedBy, or removeBlockedBy";

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

/** blockedBy is order-sensitive (insertion order preserved), so compare element-wise. */
function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Did this `update` change anything? A no-effect update — status set to its
 * current value, or a dependency re-sent unchanged — returns false, letting
 * the envelope say "No change" instead of "Updated #N". Without this, a
 * no-op update is indistinguishable from a real mutation, which can drive
 * the model to re-issue the same call in a loop.
 */
function taskChanged(before: Task, after: Task): boolean {
  return (
    before.subject !== after.subject ||
    before.status !== after.status ||
    before.description !== after.description ||
    before.activeForm !== after.activeForm ||
    !sameNumberList(before.blockedBy, after.blockedBy)
  );
}

function findDep(state: TaskState, dep: number): Task | undefined {
  return state.tasks.find((t) => t.id === dep);
}

/** Guard a create/update dependency id: must exist and must not be a tombstone. */
function checkDep(state: TaskState, dep: number, label: string): string | undefined {
  const depTask = findDep(state, dep);
  if (!depTask) {
    return `${label}: #${dep} not found`;
  }
  if (depTask.status === "deleted") {
    return `${label}: #${dep} is deleted`;
  }
  return undefined;
}

/**
 * Pure reducer: (state, action, params) → (state, op). Validation is
 * in-line and runs BEFORE any mutation, so a rejected call leaves the list
 * untouched: structural guards (subject required, id required, at least one
 * mutable field) plus state-aware checks (transition legality, dangling or
 * deleted blockedBy, self-block, cycles).
 */
export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
): ApplyResult {
  switch (action) {
    case "create": {
      if (!params.subject?.trim()) {
        return errorResult(state, "subject required for create");
      }
      // Deduped up front: the update path dedupes additions, and a repeated
      // id would otherwise persist as `⛓ #2,#2` and render twice.
      const requestedDeps = [...new Set(params.blockedBy ?? [])];
      for (const dep of requestedDeps) {
        const problem = checkDep(state, dep, "blockedBy");
        if (problem) {
          return errorResult(state, problem);
        }
      }
      const newTask: Task = {
        id: state.nextId,
        subject: params.subject,
        status: "pending",
      };
      if (params.description !== undefined) {
        newTask.description = params.description;
      }
      if (params.activeForm !== undefined) {
        newTask.activeForm = params.activeForm;
      }
      if (requestedDeps.length) {
        newTask.blockedBy = requestedDeps;
      }

      return {
        state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
        op: { kind: "create", taskId: newTask.id },
      };
    }

    case "update": {
      if (params.id === undefined) {
        return errorResult(state, "id required for update");
      }
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) {
        return errorResult(state, `#${params.id} not found`);
      }
      const current = state.tasks[idx];
      if (!current) {
        return errorResult(state, `#${params.id} not found`);
      }

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        (params.addBlockedBy !== undefined && params.addBlockedBy.length > 0) ||
        (params.removeBlockedBy !== undefined && params.removeBlockedBy.length > 0);
      if (!hasMutation) {
        return errorResult(state, MUTABLE_FIELDS_MESSAGE);
      }
      if (params.subject !== undefined && !params.subject.trim()) {
        // Same rule create enforces; an empty subject renders as a bare glyph.
        return errorResult(state, "subject cannot be empty");
      }

      let newStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
        }
        newStatus = params.status;
      }

      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const toRemove = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id) {
            return errorResult(state, `cannot block #${current.id} on itself`);
          }
          const problem = checkDep(state, dep, "addBlockedBy");
          if (problem) {
            return errorResult(state, problem);
          }
          if (!newBlockedBy.includes(dep)) {
            newBlockedBy.push(dep);
          }
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy)) {
          return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
        }
      }

      let nextTask: Task = { ...current, status: newStatus };
      if (params.subject !== undefined) {
        nextTask.subject = params.subject;
      }
      if (params.description !== undefined) {
        nextTask.description = params.description;
      }
      if (params.activeForm !== undefined) {
        nextTask.activeForm = params.activeForm;
      }
      if (newBlockedBy.length) {
        nextTask.blockedBy = newBlockedBy;
      } else {
        // Rebuilding without the field instead of keeping an empty array:
        // blockedBy is optional in the replay contract, and an empty
        // array would render as a dangling chain suffix.
        const { blockedBy: _dropped, ...withoutBlockedBy } = nextTask;
        nextTask = withoutBlockedBy;
      }

      const newTasks = [...state.tasks];
      newTasks[idx] = nextTask;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: nextTask.id,
          fromStatus: current.status,
          toStatus: newStatus,
          changed: taskChanged(current, nextTask),
        },
      };
    }

    case "list": {
      const op: Op = { kind: "list", includeDeleted: params.includeDeleted === true };
      if (params.status !== undefined) {
        op.statusFilter = params.status;
      }
      return { state, op };
    }

    case "get": {
      if (params.id === undefined) {
        return errorResult(state, "id required for get");
      }
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) {
        return errorResult(state, `#${params.id} not found`);
      }
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined) {
        return errorResult(state, "id required for delete");
      }
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) {
        return errorResult(state, `#${params.id} not found`);
      }
      const current = state.tasks[idx];
      if (!current) {
        return errorResult(state, `#${params.id} not found`);
      }
      if (current.status === "deleted") {
        return errorResult(state, `#${current.id} is already deleted`);
      }
      const updated: Task = { ...current, status: "deleted" };
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: { kind: "delete", id: updated.id, subject: updated.subject },
      };
    }

    case "clear": {
      return {
        state: { tasks: [], nextId: 1 },
        op: { kind: "clear", count: state.tasks.length },
      };
    }

    default: {
      // TaskAction is a closed union, so this is unreachable today; the
      // clause keeps the switch total if a new action lands without its
      // reducer branch.
      return errorResult(state, `unhandled todo action: ${String(action)}`);
    }
  }
}
