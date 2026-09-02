import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ASK_POPUP_TOOL_NAME, registerAskPopupTool } from "../src/ask-user-question.js";
import { ASK_POPUP_BLOCKED_EVENT } from "../src/events.js";
import type { QuestionnaireResult, QuestionParams } from "../src/tool/types.js";
import { type CapturedTool, createMockCtx, createMockPi, type MockPi } from "./mock-pi.js";

/**
 * End to end, through the real component factory and Pi's real keybindings.
 *
 * Nothing is mocked here except the terminal itself: the reducer, the router,
 * every component and the actual key sequences a terminal sends are all the
 * shipped ones. These are the tests that would notice if two correct-looking
 * layers disagreed about what a keystroke means.
 */

beforeAll(() => {
  // Real preview panes render real markdown, which reaches Pi's global theme.
  initTheme();
});

const KEY = {
  ENTER: "\r",
  ESC: "\x1b",
  DOWN: "\x1b[B",
  UP: "\x1b[A",
  TAB: "\t",
  SHIFT_TAB: "\x1b[Z",
  SPACE: " ",
  // The raw control byte every terminal and multiplexer sends for Ctrl+].
  CTRL_RBRACKET: "\x1d",
};

interface Driven {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}

const identityTheme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  strikethrough: (s: string) => s,
};

/**
 * Stand in for Pi's overlay host: build the component the same way Pi would,
 * run a keystroke script against it, and resolve with whatever it reports.
 */
interface FakeHandle {
  setHidden: ReturnType<typeof vi.fn>;
  isHidden: () => boolean;
  isFocused: () => boolean;
}

function driveOverlay(script: (component: Driven, done: (value: unknown) => void) => void) {
  const requestRender = vi.fn<() => void>();
  const handles: FakeHandle[] = [];
  const custom = (factory: unknown, options: unknown) =>
    new Promise<unknown>((resolve) => {
      const build = factory as (
        tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
        theme: typeof identityTheme,
        keybindings: ReturnType<typeof getKeybindings>,
        done: (value: unknown) => void,
      ) => Driven;
      const component = build(
        { requestRender, terminal: { columns: 120, rows: 40 } },
        identityTheme,
        getKeybindings(),
        resolve,
      );
      // Pi hands the overlay handle back through this callback right after
      // creating the overlay, which is how the session learns it can hide.
      let hidden = false;
      const handle: FakeHandle = {
        setHidden: vi.fn<(value: boolean) => void>((value: boolean) => {
          hidden = value;
        }),
        isHidden: () => hidden,
        isFocused: () => true,
      };
      handles.push(handle);
      (options as { onHandle?: (h: FakeHandle) => void }).onHandle?.(handle);
      script(component, resolve);
    });
  return { custom, requestRender, handles };
}

function register(): { mock: MockPi; tool: CapturedTool } {
  const mock = createMockPi();
  registerAskPopupTool(mock.pi);
  const tool = mock.tools.get(ASK_POPUP_TOOL_NAME);
  if (!tool) throw new Error("the tool did not register");
  return { mock, tool };
}

async function ask(
  params: QuestionParams,
  script: (component: Driven, done: (value: unknown) => void) => void,
  options: { onTerminalInput?: (handler: (data: string) => unknown) => () => void } = {},
) {
  const { mock, tool } = register();
  const { custom, requestRender, handles } = driveOverlay(script);
  const { ctx } = createMockCtx({ custom, ...options });
  const result = await tool.execute("call-1", params, undefined, undefined, ctx);
  return { details: result.details as QuestionnaireResult, requestRender, mock, handles };
}

const THREE_OPTIONS: QuestionParams = {
  questions: [
    {
      question: "Pick one",
      header: "Choice",
      options: [
        { label: "Alpha", description: "a" },
        { label: "Beta", description: "b" },
        { label: "Gamma", description: "g" },
      ],
    },
  ],
};

const MULTI: QuestionParams = {
  questions: [
    {
      question: "Pick areas",
      header: "Areas",
      multiSelect: true,
      options: [
        { label: "Frontend", description: "fe" },
        { label: "Backend", description: "be" },
        { label: "DevOps", description: "ops" },
      ],
    },
  ],
};

const TWO_QUESTIONS: QuestionParams = {
  questions: [
    {
      question: "Q1?",
      header: "First",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
    {
      question: "Q2?",
      header: "Second",
      options: [
        { label: "X", description: "x" },
        { label: "Y", description: "y" },
      ],
    },
  ],
};

describe("the overlay Pi builds", () => {
  it("renders something at a normal width", async () => {
    await ask(THREE_OPTIONS, (c, done) => {
      expect(c.render(80).length).toBeGreaterThan(0);
      done({ answers: [], cancelled: true });
    });
  });

  it("survives being invalidated before anything happens", async () => {
    await ask(THREE_OPTIONS, (c, done) => {
      expect(() => c.invalidate()).not.toThrow();
      done({ answers: [], cancelled: true });
    });
  });

  it("asks for a render as the user navigates", async () => {
    const { requestRender } = await ask(THREE_OPTIONS, (c) => {
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.ESC);
    });
    expect(requestRender).toHaveBeenCalled();
  });
});

describe("answering one question", () => {
  it("takes the highlighted option on Enter", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => c.handleInput(KEY.ENTER));
    expect(details.cancelled).toBe(false);
    expect(details.answers[0]).toMatchObject({ kind: "option", answer: "Alpha" });
  });

  it("follows the arrow keys", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => {
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]).toMatchObject({ answer: "Beta" });
  });

  it("wraps from the last row back to the first", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => {
      c.handleInput(KEY.UP);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]).toMatchObject({ answer: "Alpha" });
  });

  it("reports Esc as a decline", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => c.handleInput(KEY.ESC));
    expect(details.cancelled).toBe(true);
  });

  it("takes a typed answer from the appended row", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => {
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.DOWN);
      c.handleInput("something else entirely");
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]).toMatchObject({
      kind: "custom",
      answer: "something else entirely",
    });
  });
});

describe("choosing several", () => {
  /**
   * Rows are Frontend, Backend, DevOps, the typed row, then the commit row --
   * so the commit row is index 4, and `from` is wherever the script left the
   * highlight.
   */
  const toCommitRow = (c: Driven, from: number) => {
    for (let i = from; i < 4; i++) c.handleInput(KEY.DOWN);
  };

  it("toggles with Space and commits on the last row", async () => {
    const { details } = await ask(MULTI, (c) => {
      c.handleInput(KEY.SPACE);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.SPACE);
      toCommitRow(c, 1);
      c.handleInput(KEY.ENTER);
    });
    expect(details.cancelled).toBe(false);
    expect(details.answers[0]?.answer).toBeNull();
    expect(details.answers[0]?.selected).toEqual(["Frontend", "Backend"]);
  });

  it("toggles rather than submits when Enter lands on an option", async () => {
    // Enter means "toggle" here, not "done". Submitting on the first Enter
    // would make it impossible to pick a second option.
    const { details } = await ask(MULTI, (c) => {
      c.handleInput(KEY.ENTER);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.ENTER);
      c.handleInput(KEY.ENTER);
      toCommitRow(c, 1);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]?.selected).toEqual(["Frontend"]);
  });

  it("lets a toggle be taken back", async () => {
    const { details } = await ask(MULTI, (c) => {
      c.handleInput(KEY.SPACE);
      c.handleInput(KEY.SPACE);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.SPACE);
      toCommitRow(c, 1);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]?.selected).toEqual(["Backend"]);
  });

  it("accepts none of them as an answer", async () => {
    // Committing nothing is a real answer, not an absent one.
    const { details } = await ask(MULTI, (c) => {
      toCommitRow(c, 0);
      c.handleInput(KEY.ENTER);
    });
    expect(details.cancelled).toBe(false);
    expect(details.answers[0]?.selected).toEqual([]);
  });
});

describe("moving between questions", () => {
  it("advances on its own as each is answered, then submits", async () => {
    const { details } = await ask(TWO_QUESTIONS, (c) => {
      c.handleInput(KEY.ENTER);
      c.handleInput(KEY.ENTER);
      c.handleInput(KEY.ENTER);
    });
    expect(details.cancelled).toBe(false);
    expect(details.answers.map((a) => a.answer)).toEqual(["A", "X"]);
  });

  it("lets the user answer them out of order", async () => {
    const { details } = await ask(TWO_QUESTIONS, (c) => {
      c.handleInput(KEY.TAB); // to Q2
      c.handleInput(KEY.ENTER); // X, which advances to the review tab
      c.handleInput(KEY.SHIFT_TAB); // back to Q2
      c.handleInput(KEY.SHIFT_TAB); // back to Q1
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.ENTER); // B, advancing to Q2 again
      c.handleInput(KEY.TAB); // to the review tab
      c.handleInput(KEY.ENTER); // submit
    });
    expect(details.cancelled).toBe(false);
    expect(details.answers.find((a) => a.questionIndex === 0)?.answer).toBe("B");
    expect(details.answers.find((a) => a.questionIndex === 1)?.answer).toBe("X");
  });

  it("keeps in-progress toggles when the user tabs away mid-question", async () => {
    // Half-finished work is still work. Losing it because they looked at the
    // next question would be indefensible.
    const params: QuestionParams = {
      questions: [
        {
          question: "Q1",
          header: "H1",
          multiSelect: true,
          options: [
            { label: "FE", description: "fe" },
            { label: "BE", description: "be" },
            { label: "DB", description: "db" },
          ],
        },
        TWO_QUESTIONS.questions[1] as QuestionParams["questions"][number],
      ],
    };
    const { details } = await ask(params, (c) => {
      c.handleInput(KEY.SPACE);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.SPACE);
      c.handleInput(KEY.TAB);
      c.handleInput(KEY.ENTER);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers.find((a) => a.questionIndex === 0)?.selected).toEqual(["FE", "BE"]);
  });

  it("shows those toggles still lit when the user comes back", async () => {
    const params: QuestionParams = {
      questions: [
        {
          question: "Q1",
          header: "H1",
          multiSelect: true,
          options: [
            { label: "FE", description: "fe" },
            { label: "BE", description: "be" },
            { label: "DB", description: "db" },
          ],
        },
        TWO_QUESTIONS.questions[1] as QuestionParams["questions"][number],
      ],
    };
    const { details } = await ask(params, (c) => {
      c.handleInput(KEY.SPACE); // FE on
      c.handleInput(KEY.TAB);
      c.handleInput(KEY.SHIFT_TAB);
      c.handleInput(KEY.DOWN);
      c.handleInput(KEY.SPACE); // BE on
      for (let i = 1; i < 4; i++) c.handleInput(KEY.DOWN); // to the commit row
      c.handleInput(KEY.ENTER); // commit, advancing to Q2
      c.handleInput(KEY.ENTER); // Q2, advancing to review
      c.handleInput(KEY.ENTER); // submit
    });
    // The second toggle must add to the first, not replace it -- which it would
    // if the boxes had come back empty.
    expect(details.answers.find((a) => a.questionIndex === 0)?.selected).toEqual(["FE", "BE"]);
  });
});

describe("collapsing out of the way", () => {
  it("shrinks to one row and comes back the same size", async () => {
    let expanded = 0;
    let collapsed: string[] = [];
    let reExpanded = 0;
    await ask(THREE_OPTIONS, (c, done) => {
      expanded = c.render(120).length;
      c.handleInput(KEY.CTRL_RBRACKET);
      collapsed = c.render(120);
      c.handleInput(KEY.CTRL_RBRACKET);
      reExpanded = c.render(120).length;
      done({ answers: [], cancelled: true });
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("Ctrl+] to expand");
    expect(collapsed[0]).toContain("Esc to cancel");
    expect(expanded).toBeGreaterThan(1);
    expect(reExpanded).toBe(expanded);
  });

  it("still takes a cancel from behind the collapsed row", async () => {
    const { details } = await ask(THREE_OPTIONS, (c) => {
      c.handleInput(KEY.CTRL_RBRACKET);
      c.handleInput(KEY.ESC);
    });
    expect(details.cancelled).toBe(true);
  });
});

describe("pasted and dictated text", () => {
  it("takes a bracketed paste into the typed answer", async () => {
    const pasted = Array.from({ length: 20 }, (_v, i) => `line ${i}`).join("\n");
    const { details } = await ask(THREE_OPTIONS, (c) => {
      for (let i = 0; i < 3; i++) c.handleInput(KEY.DOWN);
      c.handleInput(`\x1b[200~${pasted}\x1b[201~`);
      c.handleInput(KEY.ENTER);
    });
    expect(details.answers[0]).toMatchObject({ kind: "custom", answer: pasted });
  });
});

describe("what the tool reports around the overlay", () => {
  it("clears the blocked flag once the overlay resolves", async () => {
    // The RPC path has its own pair; this is the overlay path's, and a listener
    // left showing that the agent is waiting is the failure that matters.
    const { mock } = await ask(THREE_OPTIONS, (c) => c.handleInput(KEY.ENTER));
    const blocked = mock.events.filter((e) => e.channel === ASK_POPUP_BLOCKED_EVENT);
    expect(blocked.map((e) => e.payload)).toEqual([{ active: true }, { active: false }]);
  });

  it("clears it even when the overlay throws", async () => {
    const { mock, tool } = register();
    const { ctx } = createMockCtx({ custom: () => Promise.reject(new Error("overlay died")) });
    await expect(tool.execute("call-1", THREE_OPTIONS, undefined, undefined, ctx)).rejects.toThrow(
      "overlay died",
    );
    const blocked = mock.events.filter((e) => e.channel === ASK_POPUP_BLOCKED_EVENT);
    expect(blocked.at(-1)?.payload).toEqual({ active: false });
  });

  it("unregisters the collapse listener when it is done", async () => {
    // One questionnaire per turn over a long session; a listener left behind by
    // each would pile up and keep consuming the key afterwards.
    const remove = vi.fn<() => void>();
    await ask(THREE_OPTIONS, (c) => c.handleInput(KEY.ENTER), {
      onTerminalInput: () => remove,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("unregisters it after a cancel too", async () => {
    const remove = vi.fn<() => void>();
    await ask(THREE_OPTIONS, (c) => c.handleInput(KEY.ESC), { onTerminalInput: () => remove });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("hiding, on a host with no way to reopen", () => {
  it("renders the collapsed row without actually hiding the overlay", async () => {
    // Pi routes no input to a hidden overlay. Without a raw terminal listener
    // the collapse key could never come back, so the dialog must stay visible
    // and merely shrink.
    let collapsed: string[] = [];
    const { handles } = await ask(THREE_OPTIONS, (c, done) => {
      c.handleInput(KEY.CTRL_RBRACKET);
      collapsed = c.render(120);
      done({ answers: [], cancelled: true });
    });
    expect(collapsed).toHaveLength(1);
    expect(handles[0]?.setHidden).not.toHaveBeenCalled();
  });

  it("does hide it once a listener exists to bring it back", async () => {
    const { handles } = await ask(
      THREE_OPTIONS,
      (c, done) => {
        c.handleInput(KEY.CTRL_RBRACKET);
        done({ answers: [], cancelled: true });
      },
      { onTerminalInput: () => () => {} },
    );
    expect(handles[0]?.setHidden).toHaveBeenCalledWith(true);
  });
});
