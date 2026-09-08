import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Markdown, MarkdownTheme } from "@earendil-works/pi-tui";
import { makeTheme } from "./fixtures.js";
import { beforeEach, describe, expect, it } from "vitest";

let markdownConstructed = 0;
class FakeMarkdown {
  constructor(public text: string) {
    markdownConstructed++;
  }
  render(width: number): string[] {
    return [`MD[${width}]:${this.text.slice(0, Math.max(0, width - 4))}`];
  }
  invalidate(): void {}
  setText(t: string): void {
    this.text = t;
  }
}
const markdownFactory = (text: string, _mt: MarkdownTheme) =>
  new FakeMarkdown(text) as unknown as Markdown;

import type { QuestionData } from "../src/tool/types.js";
import {
  type MarkdownFactory as MarkdownFactoryFn,
  PREVIEW_RENDER_FAILED_TEXT,
} from "../src/view/components/preview/markdown-content-cache.js";
import {
  NOTES_AFFORDANCE_TEXT,
  PreviewBlockRenderer,
} from "../src/view/components/preview/preview-block-renderer.js";

// SAFETY: theme is a test stub with string passthrough; cast is safe for preview rendering.
const theme = makeTheme() as unknown as Theme;
const markdownTheme = {
  heading: (t: string) => t,
  link: (t: string) => t,
  linkUrl: (t: string) => t,
  code: (t: string) => t,
  codeBlock: (t: string) => t,
  codeBlockBorder: (t: string) => t,
  quote: (t: string) => t,
  quoteBorder: (t: string) => t,
  hr: (t: string) => t,
  listBullet: (t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  underline: (t: string) => t,
} as unknown as MarkdownTheme;

const previewQuestion: QuestionData = {
  question: "pick",
  header: "pick",
  options: [
    { label: "A", description: "", preview: "## A\n\nbody A" },
    { label: "B", description: "", preview: "## B\n\nbody B" },
    { label: "C", description: "" },
  ],
};

const noPreviewQuestion: QuestionData = {
  question: "pick",
  header: "pick",
  options: [
    { label: "A", description: "" },
    { label: "B", description: "" },
  ],
};

beforeEach(() => {
  markdownConstructed = 0;
});

describe("PreviewBlockRenderer — preview gating", () => {
  it("hasAnyPreview returns true when at least one option carries preview", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    expect(r.hasAnyPreview()).toBe(true);
  });

  it("hasAnyPreview returns false when no option carries preview", () => {
    const r = new PreviewBlockRenderer({
      question: noPreviewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    expect(r.hasAnyPreview()).toBe(false);
  });

  it("has(i) is true for preview-bearing option, false for option without preview", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    expect(r.has(0)).toBe(true);
    expect(r.has(2)).toBe(false);
  });
});

describe("PreviewBlockRenderer.renderBlock", () => {
  it("emits bordered box + blank + affordance when focused on preview-bearing option", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    const lines = r.renderBlock(60, 0, "side-by-side", true, false);
    expect(lines.some((l) => l.startsWith("┌"))).toBe(true);
    expect(lines.some((l) => l.startsWith("└"))).toBe(true);
    expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
  });

  it("hides affordance when notesVisible=true (notes mode active)", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    const lines = r.renderBlock(60, 0, "side-by-side", true, true);
    expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
  });

  it("hides affordance when focused=false (cursor elsewhere)", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    const lines = r.renderBlock(60, 0, "side-by-side", false, false);
    expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
  });

  it("hides affordance when focused option lacks a preview (height contract preserved)", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    const linesA = r.renderBlock(60, 0, "side-by-side", true, false);
    const linesB = r.renderBlock(60, 2, "side-by-side", true, false);
    expect(linesA.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
    expect(linesB.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
    expect(linesA.length).toBe(linesB.length);
  });
});

describe("PreviewBlockRenderer.blockHeight", () => {
  it("matches renderBlock(...).length under all gating combinations", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    for (const idx of [0, 1, 2]) {
      for (const mode of ["side-by-side", "stacked"] as const) {
        expect(r.blockHeight(60, idx, mode)).toBe(r.renderBlock(60, idx, mode, true, false).length);
      }
    }
  });
});

describe("PreviewBlockRenderer — cache lifecycle", () => {
  it("creates one Markdown per option lazily; revisit hits cache", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    r.renderBlock(60, 0, "side-by-side", true, false);
    expect(markdownConstructed).toBe(1);
    r.renderBlock(60, 1, "side-by-side", true, false);
    expect(markdownConstructed).toBe(2);
    r.renderBlock(60, 0, "side-by-side", true, false);
    expect(markdownConstructed).toBe(2);
  });

  it("invalidate() does NOT delete instances; subsequent renders re-use cache", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    r.renderBlock(60, 0, "side-by-side", true, false);
    expect(markdownConstructed).toBe(1);
    r.invalidate();
    r.renderBlock(60, 0, "side-by-side", true, false);
    expect(markdownConstructed).toBe(1);
  });
});

describe("PreviewBlockRenderer — untrusted preview markdown", () => {
  class ThrowingMarkdown {
    render(_width: number): string[] {
      throw new Error("boom");
    }
    invalidate(): void {}
  }
  const throwingFactory = (_t: string, _mt: MarkdownTheme) =>
    new ThrowingMarkdown() as unknown as Markdown;

  it("returns a single fallback line instead of throwing when Markdown.render throws", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory: throwingFactory,
    });

    const lines = r.renderBlock(40, 0, "side-by-side", true, false);
    expect(lines.some((l) => l.includes(PREVIEW_RENDER_FAILED_TEXT))).toBe(true);
    // The fallback preserves the height contract: blockHeight still equals renderBlock().length.
    expect(r.blockHeight(40, 0, "side-by-side")).toBe(lines.length);
  });

  it("blockHeight measures the fallback line without throwing (height probes are on the crash path too)", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory: throwingFactory,
    });

    expect(r.blockHeight(20, 1, "stacked")).toBeGreaterThan(0);
  });

  it("never throws for random preview strings through the real Markdown renderer", () => {
    // Seeded LCG so a failure is reproducible from the seed, not a flaky roll.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const chunks = [
      "#",
      "##",
      "*",
      "**",
      "`",
      "```",
      "~~~",
      "-",
      ">",
      "|",
      "[",
      "]",
      "(",
      ")",
      "_",
      "\\",
      "$",
      "$$",
      "&",
      "<",
      "!",
      " \t",
      "\n",
      "\r",
      "😀",
      "中",
      "\x1b[31m",
      "abc",
      "XYZ",
      "0123",
      " ",
    ];
    const randText = () => {
      const n = 1 + Math.floor(rand() * 40);
      let s = "";
      for (let i = 0; i < n; i++) {
        s += chunks[Math.floor(rand() * chunks.length)] ?? "";
      }
      return s;
    };

    for (let round = 0; round < 60; round++) {
      const question: QuestionData = {
        question: "q",
        header: "q",
        options: [0, 1, 2].map((i) => ({ label: `o${i}`, description: "", preview: randText() })),
      };
      // No markdownFactory: the real pi-tui Markdown runs, which is the surface
      // the fuzz is meant to protect.
      const r = new PreviewBlockRenderer({ question, theme, markdownTheme });
      for (const width of [1, 3, 12, 40, 100]) {
        for (let i = 0; i < question.options.length; i++) {
          const lines = r.renderBlock(width, i, "side-by-side", true, false);
          expect(lines.length).toBeGreaterThan(0);
          expect(r.blockHeight(width, i, "stacked")).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("PreviewBlockRenderer — per-option width cache", () => {
  /** Counts every render, per option text, with no cache of its own. */
  function countingFactory(): {
    factory: MarkdownFactoryFn;
    renders: () => Record<string, number>;
  } {
    const renders: Record<string, number> = {};
    class CountingMarkdown {
      constructor(private readonly text: string) {}
      render(width: number): string[] {
        renders[this.text] = (renders[this.text] ?? 0) + 1;
        return [`MD[${width}]:${this.text}`];
      }
      invalidate(): void {}
    }
    return {
      factory: (text: string, _mt: MarkdownTheme) =>
        new CountingMarkdown(text) as unknown as Markdown,
      renders: () => renders,
    };
  }

  it("re-renders only the option asked for after a width flip", () => {
    const { factory, renders } = countingFactory();
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory: factory,
    });

    r.blockHeight(60, 0, "side-by-side");
    r.blockHeight(50, 1, "side-by-side");
    expect(renders()).toEqual({ "## A\n\nbody A": 1, "## B\n\nbody B": 1 });

    // Option 0 was never measured at 50, so the flip must not have touched it.
    r.blockHeight(60, 0, "side-by-side");
    expect(renders()["## A\n\nbody A"]).toBe(1);

    // A width option 0 has not seen does re-render it.
    r.blockHeight(50, 0, "side-by-side");
    expect(renders()["## A\n\nbody A"]).toBe(2);
  });

  it("measures and renders one option in a frame with a single markdown render", () => {
    const { factory, renders } = countingFactory();
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory: factory,
    });
    r.blockHeight(60, 0, "side-by-side");
    r.renderBlock(60, 0, "side-by-side", true, false);
    expect(renders()["## A\n\nbody A"]).toBe(1);
  });

  it("invalidate drops the stored rows", () => {
    const { factory, renders } = countingFactory();
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory: factory,
    });
    r.blockHeight(60, 0, "side-by-side");
    r.invalidate();
    r.blockHeight(60, 0, "side-by-side");
    expect(renders()["## A\n\nbody A"]).toBe(2);
  });

  it("hands each caller its own array", () => {
    const r = new PreviewBlockRenderer({
      question: previewQuestion,
      theme,
      markdownTheme,
      markdownFactory,
    });
    const first = r.renderBlock(60, 0, "side-by-side", true, false);
    first[1] = "mutated by the caller";
    const second = r.renderBlock(60, 0, "side-by-side", true, false);
    expect(second[1]).not.toBe("mutated by the caller");
  });
});
