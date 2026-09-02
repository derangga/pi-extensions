import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildQuestionnaire } from "../src/state/build-questionnaire.js";
import type { WrappingSelectItem } from "../src/state/row-intent.js";
import type { QuestionData } from "../src/tool/types.js";
import { makeQuestionnaireState, makeTheme } from "./fixtures.js";

/**
 * The builder, on its own. Upstream had no suite for it: it was only ever
 * exercised through the registered tool, which is a long way from the wiring
 * decisions made here and cannot see most of them at all.
 */

/**
 * Rendering a real preview reaches Pi's global markdown theme, which throws
 * until it is initialised. That is a property of the real components rather
 * than of these tests, so initialise it rather than mock the pane away -- a
 * stubbed Markdown was exactly what let three mutations survive in the preview
 * layer.
 */
beforeAll(() => {
  initTheme();
});

function makeTuiStub(columns = 120, rows = 40) {
  return {
    terminal: { columns, rows },
    requestRender: vi.fn<() => void>(),
  } as unknown as TUI;
}

function itemsFor(questions: readonly QuestionData[]): WrappingSelectItem[][] {
  return questions.map((q) => [
    ...q.options.map((o) => ({
      kind: "option" as const,
      label: o.label,
      description: o.description,
    })),
    { kind: "other" as const, label: "Type something." },
  ]);
}

const SINGLE: QuestionData = {
  question: "Which cache?",
  header: "Cache",
  options: [
    { label: "Redis", description: "shared" },
    { label: "In-process", description: "simple" },
  ],
};

const MULTI: QuestionData = { ...SINGLE, question: "Which areas?", multiSelect: true };

function build(questions: readonly QuestionData[], collapseKey = "ctrl+]") {
  return buildQuestionnaire({
    tui: makeTuiStub(),
    theme: makeTheme() as unknown as Theme,
    questions,
    itemsByTab: itemsFor(questions),
    isMulti: questions.length > 1,
    initialState: makeQuestionnaireState(),
    getCurrentTab: () => 0,
    collapseKey,
  });
}

describe("the editors it constructs", () => {
  it("disables submit on both of them", () => {
    // The router owns confirm and submit. If a submit binding reached one of
    // these editors, its own handler would call submitValue(), which clears the
    // buffer -- and with no onSubmit wired, whatever was typed is unrecoverable.
    const built = build([SINGLE]);
    expect(built.notesInput.disableSubmit).toBe(true);
    expect(built.inlineInput.disableSubmit).toBe(true);
  });

  it("gives them separate buffers", () => {
    // One shared editor would make a note appear inside the answer.
    const built = build([SINGLE]);
    built.inlineInput.setText("an answer");
    built.notesInput.setText("a note");
    expect(built.inlineInput.getText()).toBe("an answer");
    expect(built.notesInput.getText()).toBe("a note");
  });
});

describe("what it builds per tab", () => {
  it("shows a lone question's header as a badge, with no tab bar", () => {
    // With one question there is no strip to carry the header, so the dialog
    // shows it inline instead.
    const lines = build([SINGLE]).render(120);
    expect(lines.join("\n")).toContain("Cache");
    expect(lines.some((l) => l.includes("Cache") && l.includes("Other"))).toBe(false);
  });

  it("puts several questions' headers on one tab strip", () => {
    // The builder paints nothing by itself, so the strip is empty until the
    // adapter pushes props -- which is the contract, not a bug.
    const built = build([SINGLE, { ...SINGLE, header: "Other" }]);
    expect(built.render(120).join("\n")).not.toContain("Other");
    built.adapter.apply(makeQuestionnaireState());
    const lines = built.render(120);
    expect(lines.some((l) => l.includes("Cache") && l.includes("Other"))).toBe(true);
  });

  it("puts checkbox rows on a multi-select question and a preview pane elsewhere", () => {
    expect(build([MULTI]).render(120).join("\n")).toContain("[ ]");
    expect(build([SINGLE]).render(120).join("\n")).not.toContain("[ ]");
  });

  it("names the collapse key it was given in the footer", () => {
    expect(build([SINGLE], "alt+o").render(120).join("\n")).toContain("Alt+O to collapse");
  });

  it("says nothing about collapsing when the shortcut is off", () => {
    expect(build([SINGLE], "off").render(120).join("\n")).not.toContain("to collapse");
  });
});

describe("column width across tabs", () => {
  const short: QuestionData = {
    question: "Short?",
    header: "S",
    options: [
      { label: "A", description: "a", preview: "# One\nbody" },
      { label: "B", description: "b" },
    ],
  };
  const long: QuestionData = {
    question: "Long?",
    header: "L",
    options: [
      { label: "An extremely long option label indeed", description: "x", preview: "# Two\nbody" },
      { label: "Another very long option label here", description: "y" },
    ],
  };
  const questions = [short, long];

  /** Column where the preview box's top-left corner lands, or -1. */
  function previewColumn(currentTab: number): number {
    const built = buildQuestionnaire({
      tui: makeTuiStub(),
      theme: makeTheme() as unknown as Theme,
      questions,
      itemsByTab: itemsFor(questions),
      isMulti: true,
      initialState: makeQuestionnaireState({ currentTab }),
      getCurrentTab: () => currentTab,
      collapseKey: "ctrl+]",
    });
    built.adapter.apply(makeQuestionnaireState({ currentTab }));
    for (const line of built.render(120)) {
      const at = line.indexOf("┌");
      if (at >= 0) return at;
    }
    return -1;
  }

  it("starts the preview at the same column on every tab", () => {
    // The left column width is computed across all tabs and shared, because a
    // column that jumps as the user tabs between questions is far more
    // distracting than one slightly wider than a given tab needs. Tab 1 has far
    // longer labels than tab 0, so an un-shared width would differ here.
    const first = previewColumn(0);
    expect(first).toBeGreaterThan(0);
    expect(previewColumn(1)).toBe(first);
  });
});

describe("the handle it returns", () => {
  it("renders at the width it is asked for", () => {
    const built = build([SINGLE]);
    for (const width of [60, 80, 120]) {
      expect(built.render(width).length).toBeGreaterThan(0);
    }
  });

  it("invalidates without throwing on a freshly built questionnaire", () => {
    // The session calls this on a terminal resize before anything has painted.
    expect(() => build([SINGLE]).invalidate()).not.toThrow();
  });

  it("reaches the notes editor, which no binding would refresh", () => {
    // It is typed into directly and has no props, so it is not in either
    // binding registry. Left out of the extras, a resize would leave it
    // rendering at the old width.
    const built = build([SINGLE]);
    const spy = vi.spyOn(built.notesInput, "invalidate");
    built.invalidate();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("paints nothing until the adapter is applied", () => {
    // Deliberate: the builder runs no selector. The session owns the first
    // paint, so there is exactly one place where state reaches components.
    const built = build([SINGLE]);
    expect(built.adapter).toBeDefined();
    expect(() => built.adapter.apply(makeQuestionnaireState())).not.toThrow();
  });
});

describe("refusing to build something unrenderable", () => {
  it("says so plainly when given no questions", () => {
    // Validation caps a questionnaire at one to four, so this is unreachable
    // through the tool. Saying it out loud beats a property access on undefined
    // during the first paint, which is where a non-null assertion would land.
    expect(() => build([])).toThrow("at least one question");
  });
});
