import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import unslopExtension from "../src/index.js";

/**
 * The extension is four lines, so these tests guard the two things those four
 * lines can silently get wrong: swallowing part of the host's prompt, and
 * leaking Cursor skill metadata into it.
 */

type BeforeAgentStart = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void;

/** Only `on` is stubbed. It is the only method the entry point calls. */
function stubApi(): { pi: ExtensionAPI; handlers: Map<string, BeforeAgentStart> } {
  const handlers = new Map<string, BeforeAgentStart>();
  const pi = {
    on(event: string, handler: BeforeAgentStart): void {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function registeredHandler(): BeforeAgentStart {
  const { pi, handlers } = stubApi();
  unslopExtension(pi);
  const handler = handlers.get("before_agent_start");
  if (!handler) throw new Error("no before_agent_start handler registered");
  return handler;
}

async function inject(systemPrompt: string): Promise<string> {
  const result = await registeredHandler()(
    {
      type: "before_agent_start",
      prompt: "",
      systemPrompt,
      systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
    },
    {} as ExtensionContext,
  );
  const injected = (result as BeforeAgentStartEventResult | undefined)?.systemPrompt;
  if (injected === undefined) throw new Error("handler returned no systemPrompt");
  return injected;
}

describe("pi-unslop injection", () => {
  it("subscribes to before_agent_start and nothing else", () => {
    // Every other turn-scoped hook loses the text to compaction or resume.
    const { pi, handlers } = stubApi();
    unslopExtension(pi);
    expect([...handlers.keys()]).toEqual(["before_agent_start"]);
  });

  it("keeps the host prompt intact and appends after a blank line", async () => {
    const injected = await inject("BASE PROMPT");
    expect(injected.startsWith("BASE PROMPT\n\n")).toBe(true);
    expect(injected.length).toBeGreaterThan("BASE PROMPT\n\n".length);
  });

  it("carries the always-on preamble, which is the part upstream does not have", async () => {
    const injected = await inject("BASE");
    expect(injected).toContain("## Persistence");
    expect(injected).toContain("## Scope");
    expect(injected).toContain("Active every response.");
  });

  it("puts the scope guard before the rules it scopes", async () => {
    // A guard that arrives after 31 rewrite instructions has already lost.
    // Anchored to line starts: the provenance comment names "## Process" in
    // prose, and an unanchored search finds that instead of the heading.
    const heading = (text: string, name: string): number => text.indexOf(`\n${name}\n`);
    const injected = await inject("BASE");
    expect(heading(injected, "## Scope")).toBeGreaterThan(-1);
    expect(heading(injected, "## Scope")).toBeLessThan(heading(injected, "## Process"));
    expect(heading(injected, "## Process")).toBeLessThan(
      heading(injected, "## Patterns to detect and fix"),
    );
  });

  it("carries upstream's rules, first through last", async () => {
    const injected = await inject("BASE");
    expect(injected).toContain("1. **Puffery.**");
    expect(injected).toContain("31. **Prefer the plain word.**");
  });

  it("leaks no skill frontmatter", async () => {
    // The upstream file opens with Cursor skill metadata, including
    // `disable-model-invocation`. In a system prompt that is noise at best.
    const injected = await inject("BASE");
    expect(injected).not.toContain("disable-model-invocation");
    expect(injected).not.toContain("\nname: unslop");
  });

  it("states where the text came from", async () => {
    const injected = await inject("BASE");
    expect(injected).toContain("github.com/cursor/plugins");
    expect(injected).toContain("Lauren Tan");
  });

  it("appends the same text every turn instead of accumulating", async () => {
    const handler = registeredHandler();
    const event = {
      type: "before_agent_start",
      prompt: "",
      systemPrompt: "BASE",
      systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
    } as const;
    const first = await handler(event, {} as ExtensionContext);
    const second = await handler(event, {} as ExtensionContext);
    expect((second as BeforeAgentStartEventResult).systemPrompt).toBe(
      (first as BeforeAgentStartEventResult).systemPrompt,
    );
  });
});
