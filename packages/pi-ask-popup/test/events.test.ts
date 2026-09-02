import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASK_POPUP_BLOCKED_EVENT,
  ASK_POPUP_PROMPT_EVENT,
  buildBlockedPayload,
  buildPromptPayload,
  type PromptSource,
} from "../src/events.js";
import type { QuestionParams } from "../src/tool/types.js";

const EVENTS_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../src/events.ts");

function source(over: Partial<PromptSource> = {}): PromptSource {
  return {
    questions: over.questions ?? [
      {
        question: "Which cache?",
        header: "Cache",
        options: [
          { label: "Redis", description: "shared" },
          { label: "In-process", description: "simple", preview: "# Notes\nlorem" },
        ],
      },
    ],
  };
}

describe("the channel names", () => {
  it("are namespaced to this package", () => {
    // Subscribers hardcode these. Renaming one is a breaking change that no
    // compiler catches, in either this package or theirs.
    expect(ASK_POPUP_PROMPT_EVENT).toBe("pi-ask-popup:prompt");
    expect(ASK_POPUP_BLOCKED_EVENT).toBe("pi-ask-popup:blocked");
  });
});

describe("buildPromptPayload", () => {
  it("carries the question text, the header and the option copy", () => {
    const { questions } = buildPromptPayload(source());
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      question: "Which cache?",
      header: "Cache",
      multiSelect: false,
      options: [
        { label: "Redis", description: "shared", hasPreview: false },
        { label: "In-process", description: "simple", hasPreview: true },
      ],
    });
  });

  it("reports that a preview exists without shipping it", () => {
    // Preview content runs to hundreds of lines and would be forwarded across
    // process boundaries by every listener that relays these events.
    const json = JSON.stringify(buildPromptPayload(source()));
    expect(json).toContain('"hasPreview":true');
    expect(json).not.toContain("lorem");
  });

  it("treats an empty preview string as no preview", () => {
    const { questions } = buildPromptPayload(
      source({
        questions: [
          {
            question: "q",
            header: "h",
            options: [{ label: "A", description: "a", preview: "" }],
          },
        ],
      }),
    );
    expect(questions[0]?.options[0]?.hasPreview).toBe(false);
  });

  it("normalizes an absent multiSelect to false", () => {
    // Listeners should never have to distinguish absent from false.
    const { questions } = buildPromptPayload(source());
    expect(questions[0]?.multiSelect).toBe(false);
    const multi = buildPromptPayload(
      source({
        questions: [{ question: "q", header: "h", multiSelect: true, options: [] }],
      }),
    );
    expect(multi.questions[0]?.multiSelect).toBe(true);
  });

  it("forwards nothing beyond the declared fields", () => {
    // Copied field by field rather than spread: a spread would leak whatever
    // else the tool parameters happen to grow later.
    const withExtras = {
      questions: [
        {
          question: "q",
          header: "h",
          secret: "internal",
          options: [{ label: "A", description: "a", preview: "p", secret: "internal" }],
        },
      ],
    } as unknown as PromptSource;
    expect(JSON.stringify(buildPromptPayload(withExtras))).not.toContain("internal");
  });

  it("survives a JSON round trip unchanged", () => {
    // Rule 5: a listener that relays across a process boundary must see the
    // same payload. A Map or Date here would arrive as {} at the far end.
    const payload = buildPromptPayload(source());
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("accepts the tool's own validated parameters", () => {
    // The structural source type has to keep matching QuestionParams, or the
    // import-free declaration has quietly drifted from what it describes.
    const params: QuestionParams = {
      questions: [
        {
          question: "Which cache?",
          header: "Cache",
          options: [
            { label: "Redis", description: "shared" },
            { label: "In-process", description: "simple" },
          ],
        },
      ],
    };
    expect(buildPromptPayload(params).questions[0]?.header).toBe("Cache");
  });
});

describe("buildBlockedPayload", () => {
  it("carries the flag both ways", () => {
    expect(buildBlockedPayload(true)).toEqual({ active: true });
    expect(buildBlockedPayload(false)).toEqual({ active: false });
  });
});

describe("the events module stays cheap to import", () => {
  it("imports nothing at all", () => {
    // The whole reason the ./events subpath exists. One import of the tool
    // types would pull typebox into a listener that wants four interfaces.
    const text = readFileSync(EVENTS_SOURCE, "utf8");
    const imports = text.match(/^\s*(?:import|export)\s.*\sfrom\s.*$/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("reads the file it claims to check", () => {
    // Guards the guard: a mis-rooted path would pass forever.
    expect(readFileSync(EVENTS_SOURCE, "utf8")).toContain(ASK_POPUP_PROMPT_EVENT);
  });
});
