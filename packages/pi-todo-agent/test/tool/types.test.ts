import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  TOOL_NAME,
  TodoParamsSchema,
  type TaskDetails,
  type TodoParams,
} from "../../src/tool/types.js";

describe("tool identity", () => {
  it("keeps the tool name 'todo'", () => {
    // Replay and any user-facing docs key off this exact string.
    expect(TOOL_NAME).toBe("todo");
  });
});

describe("TodoParamsSchema", () => {
  it("accepts a valid create call", () => {
    const params: TodoParams = {
      action: "create",
      subject: "research existing tools",
      description: "Check how other agents track multi-step work",
    };
    expect(Value.Check(TodoParamsSchema, params)).toBe(true);
  });

  it("rejects an unknown action", () => {
    expect(Value.Check(TodoParamsSchema, { action: "reorder", subject: "x" })).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(Value.Check(TodoParamsSchema, { action: "update", id: 1, status: "archived" })).toBe(
      false,
    );
  });

  it("accepts every action variant and the dependency fields", () => {
    for (const action of ["create", "update", "list", "get", "delete", "clear"] as const) {
      expect(Value.Check(TodoParamsSchema, { action })).toBe(true);
    }
    expect(
      Value.Check(TodoParamsSchema, {
        action: "create",
        subject: "deploy",
        blockedBy: [2, 3],
      }),
    ).toBe(true);
    expect(
      Value.Check(TodoParamsSchema, {
        action: "update",
        id: 1,
        addBlockedBy: [4],
        removeBlockedBy: [2],
      }),
    ).toBe(true);
    expect(
      Value.Check(TodoParamsSchema, {
        action: "list",
        status: "pending",
        includeDeleted: true,
      }),
    ).toBe(true);
  });

  it("carries LLM-facing descriptions on every parameter", () => {
    // Schema descriptions double as prompt copy for the model; an empty one
    // leaves the model guessing at the field's purpose.
    const properties = TodoParamsSchema.properties as Record<string, { description?: string }>;
    for (const [name, prop] of Object.entries(properties)) {
      expect(
        prop.description?.length ?? 0,
        `parameter ${name} needs a description`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("TaskDetails", () => {
  it("documents the snapshot shape replay depends on", () => {
    const details: TaskDetails = {
      action: "create",
      params: { action: "create", subject: "write tests" },
      tasks: [{ id: 1, subject: "write tests", status: "pending" }],
      nextId: 2,
    };
    expect(details.tasks[0]?.status).toBe("pending");
  });
});
