import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { ParentTraffic } from "../src/intercom.js";
import type { RunView, TaskView, WaitOutcome } from "../src/run.js";
import { THINKING_LEVELS } from "../src/thinking.js";
import {
  createSubagentTools,
  formatRun,
  formatStart,
  formatTrafficReport,
  type SubagentToolHost,
} from "../src/tools.js";

function taskView(fields: Partial<TaskView> = {}): TaskView {
  return {
    id: "a",
    index: 0,
    wave: 0,
    agent: "a reader",
    task: "read the code",
    needs: [],
    model: "anthropic/claude-opus-5",
    thinking: "off",
    status: "settled",
    outcome: "completed",
    output: "the answer",
    sessionFile: "/sessions/a.jsonl",
    turns: 3,
    missing: [],
    notes: [],
    ...fields,
  };
}

function runView(tasks: readonly TaskView[], fields: Partial<RunView> = {}): RunView {
  return {
    id: "run_1",
    startedAt: 0,
    finished: true,
    cancelled: false,
    tasks,
    ...fields,
  };
}

function address(taskId: string) {
  return { runId: "run_1", taskId, task: "read the code" };
}

/** Records what each tool asked of the manager, and answers from a table. */
function host(overrides: Partial<SubagentToolHost> = {}): SubagentToolHost {
  const refuse = () => Promise.reject(new Error("not stubbed"));
  return {
    start: refuse,
    wait: refuse,
    view: refuse,
    reply: refuse,
    cancel: refuse,
    ...overrides,
  } as SubagentToolHost;
}

function tool(name: string, overrides: Partial<SubagentToolHost> = {}): ToolDefinition {
  const found = createSubagentTools(host(overrides)).find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

async function call(definition: ToolDefinition, params: unknown): Promise<string> {
  const result = await definition.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("the tool surface", () => {
  it("is exactly four tools", () => {
    // Every tool here costs context in the orchestrator's spec on every
    // request. A fifth one is a decision, not a drift.
    expect(createSubagentTools(host()).map((entry) => entry.name)).toEqual([
      "subagent",
      "subagent_result",
      "reply_subagent",
      "subagent_cancel",
    ]);
  });

  it("offers thinking as a closed enum rather than a free string", () => {
    const parameters = tool("subagent").parameters as {
      properties: {
        tasks: { items: { properties: { thinking: { anyOf: { const: string }[] } } } };
      };
    };
    const thinking = parameters.properties.tasks.items.properties.thinking;
    expect(thinking.anyOf.map((entry) => entry.const)).toEqual([...THINKING_LEVELS]);
  });

  it("tells the orchestrator to batch, to use needs, and to end its turn", () => {
    const guidelines = (tool("subagent").promptGuidelines ?? []).join(" ");
    expect(guidelines).toContain("one subagent call");
    expect(guidelines).toContain("needs");
    expect(guidelines).toContain("End your turn");
  });
});

describe("formatStart", () => {
  it("omits the wave line when nothing has edges", () => {
    const text = formatStart(runView([taskView({ id: "a" }), taskView({ id: "b", index: 1 })]));
    expect(text).toContain("Started run_1 with 2 tasks.");
    expect(text).not.toContain("wave");
  });

  it("shows waves and edges once a task has needs", () => {
    const text = formatStart(
      runView([taskView({ id: "up" }), taskView({ id: "down", index: 1, wave: 1, needs: ["up"] })]),
    );
    expect(text).toContain("wave 2");
    expect(text).toContain("needs up");
  });
});

describe("formatRun", () => {
  it("reports each task's outcome, transcript and output", () => {
    const text = formatRun(runView([taskView()]));
    expect(text).toContain("run_1: all 1 task settled.");
    expect(text).toContain("## read the code (a) — completed");
    expect(text).toContain("transcript: /sessions/a.jsonl");
    expect(text).toContain("the answer");
    expect(text).not.toContain("model:");
  });

  it("adds model, thinking, turns and notes only when verbose", () => {
    const text = formatRun(runView([taskView({ notes: ["fell back to the session model"] })]), {
      verbose: true,
    });
    expect(text).toContain("model: anthropic/claude-opus-5");
    expect(text).toContain("turns: 3");
    expect(text).toContain("note: fell back to the session model");
  });

  it("names the needs that failed when a task was skipped", () => {
    const text = formatRun(
      runView([
        taskView({
          id: "down",
          status: "skipped",
          outcome: undefined,
          output: undefined,
          sessionFile: undefined,
          missing: ["up"],
        }),
      ]),
    );
    expect(text).toContain("skipped (up produced nothing)");
    expect(text).toContain("(no output)");
  });

  it("says how far along an unfinished run is", () => {
    const text = formatRun(
      runView(
        [taskView(), taskView({ id: "b", index: 1, status: "running", outcome: undefined })],
        {
          finished: false,
        },
      ),
    );
    expect(text).toContain("1 of 2 settled, still running");
  });

  it("narrows to one task when asked for one", () => {
    const text = formatRun(runView([taskView(), taskView({ id: "b", index: 1, task: "other" })]), {
      taskId: "b",
    });
    expect(text).toContain("(b)");
    expect(text).not.toContain("(a)");
  });
});

describe("formatTrafficReport", () => {
  it("quotes a question and points at reply_subagent", () => {
    const traffic: ParentTraffic[] = [
      { kind: "ask", address: address("a"), text: "which branch?" },
    ];
    const text = formatTrafficReport(
      runView([taskView({ status: "running" })], { finished: false }),
      traffic,
    );
    expect(text).toContain("which branch?");
    expect(text).toContain("reply_subagent");
  });

  it("names a settled task without repeating output the run result will carry", () => {
    const traffic: ParentTraffic[] = [
      { kind: "settled", address: address("a"), text: "the whole answer", outcome: "completed" },
    ];
    const text = formatTrafficReport(runView([taskView()], { finished: false }), traffic);
    expect(text).toContain("[read the code (a) completed]");
    expect(text).not.toContain("the whole answer");
  });
});

describe("subagent", () => {
  it("returns the run id and does not wait by default", async () => {
    let waited = false;
    const text = await call(
      tool("subagent", {
        start: async () => runView([taskView()], { finished: false }),
        wait: async () => {
          waited = true;
          return { kind: "settled", run: runView([taskView()]) } satisfies WaitOutcome;
        },
      }),
      { tasks: [{ agent: "a reader", task: "read the code", prompt: "read" }] },
    );

    expect(waited).toBe(false);
    expect(text).toContain("Started run_1");
    expect(text).toContain("End your turn");
  });

  it("returns the whole run when autoAwait is set", async () => {
    const text = await call(
      tool("subagent", {
        start: async () => runView([taskView()], { finished: false }),
        wait: async () => ({ kind: "settled", run: runView([taskView()]) }) satisfies WaitOutcome,
      }),
      {
        tasks: [{ agent: "a reader", task: "read the code", prompt: "read" }],
        autoAwait: true,
      },
    );

    expect(text).toContain("all 1 task settled");
    expect(text).toContain("the answer");
  });

  it("surfaces a refused call as a tool error", async () => {
    await expect(
      call(
        tool("subagent", {
          start: () => Promise.reject(new Error('Task "a" needs itself.')),
        }),
        { tasks: [] },
      ),
    ).rejects.toThrow("needs itself");
  });
});

describe("subagent_result", () => {
  it("reads without waiting unless asked to wait", async () => {
    const asked: string[] = [];
    const text = await call(
      tool("subagent_result", {
        view: async (runId) => {
          asked.push(`view:${runId}`);
          return runView([taskView()]);
        },
      }),
      { runId: "run_1" },
    );

    expect(asked).toEqual(["view:run_1"]);
    expect(text).toContain("the answer");
  });

  it("returns a child's question instead of the run when one arrives", async () => {
    const text = await call(
      tool("subagent_result", {
        wait: async () =>
          ({
            kind: "traffic",
            run: runView([taskView({ status: "running" })], { finished: false }),
            messages: [{ kind: "ask", address: address("a"), text: "which branch?" }],
          }) satisfies WaitOutcome,
      }),
      { wait: true },
    );

    expect(text).toContain("which branch?");
  });
});

describe("reply_subagent", () => {
  it("says when the child was resumed", async () => {
    const text = await call(tool("reply_subagent", { reply: async () => "delivered" }), {
      taskId: "a",
      message: "the master branch",
    });
    expect(text).toBe("Delivered to a.");
  });

  it("says when nothing was waiting, rather than pretending it landed", async () => {
    const text = await call(tool("reply_subagent", { reply: async () => "not_waiting" }), {
      taskId: "a",
      message: "too late",
    });
    expect(text).toContain("not waiting");
  });
});

describe("subagent_cancel", () => {
  it("counts what it stopped", async () => {
    const text = await call(
      tool("subagent_cancel", {
        cancel: async () =>
          runView(
            [taskView(), taskView({ id: "b", index: 1, status: "running", outcome: undefined })],
            { finished: false, cancelled: true },
          ),
      }),
      {},
    );

    expect(text).toContain("Cancelled run_1");
    expect(text).toContain("1 task stopped");
  });
});
