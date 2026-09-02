import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { QuestionnaireSession } from "../src/state/questionnaire-session.js";
import type { WrappingSelectItem } from "../src/state/row-intent.js";
import type { QuestionnaireResult, QuestionParams } from "../src/tool/types.js";
import { makeTheme } from "./fixtures.js";

/**
 * The session drives the real reducer, the real router and the real components
 * -- only the terminal and the external editor are stood in for. So these read
 * as keystroke scripts, which is the level the behaviour actually lives at: a
 * draft surviving a trip up to another option is not a property of any one
 * function.
 */

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
  questions: [
    {
      question: "Which?",
      header: "Pick",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
  ],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
  return value.questions.map((question) => [
    ...question.options.map((option) => ({
      kind: "option" as const,
      label: option.label,
      description: option.description,
    })),
    { kind: "other" as const, label: "Type something." },
  ]);
}

/** Only the bindings these scripts press. Everything else falls through as text. */
const keybindings = {
  matches(data: string, name: string): boolean {
    switch (name) {
      case "tui.select.up":
        return data === UP;
      case "tui.select.down":
        return data === DOWN;
      case "tui.select.confirm":
        return data === ENTER;
      case "tui.input.newLine":
        return data === SHIFT_ENTER;
      case "tui.editor.cursorUp":
        return data === UP;
      case "tui.editor.cursorDown":
        return data === DOWN;
      case "tui.select.cancel":
        return data === ESC;
      case "tui.editor.deleteToLineStart":
        return data === CTRL_U;
      case "app.editor.external":
        return data === CTRL_G;
      default:
        return false;
    }
  },
};

interface SessionOptions {
  params?: QuestionParams;
  itemsByTab?: WrappingSelectItem[][];
  editInput?: (value: string) => Promise<string | undefined>;
  keybindings?: typeof keybindings;
  collapseKey?: string;
  canReopenWhileHidden?: boolean;
}

function makeSession(options: SessionOptions = {}) {
  const sessionParams = options.params ?? params;
  const done = vi.fn<(result: QuestionnaireResult) => void>();
  const requestRender = vi.fn<() => void>();
  const session = new QuestionnaireSession({
    tui: { terminal: { columns: 120, rows: 40 }, requestRender } as unknown as TUI,
    theme: makeTheme() as unknown as Theme,
    params: sessionParams,
    itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
    done,
    keybindings: options.keybindings ?? keybindings,
    editInput: options.editInput ?? (() => Promise.resolve(undefined)),
    collapseKey: options.collapseKey ?? "off",
    canReopenWhileHidden: options.canReopenWhileHidden ?? false,
  });
  return { session, done, requestRender };
}

/** Two rows down from the top lands on "Type something." in the default fixture. */
function focusCustomAnswer(session: QuestionnaireSession): void {
  session.dispatch(DOWN);
  session.dispatch(DOWN);
}

function view(session: QuestionnaireSession): string {
  return session.component.render(120).join("\n");
}

/** Let the external-editor promise and its continuation settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("custom-answer drafts", () => {
  it("keeps a draft while the user browses away and comes back", () => {
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch("draft answer");
    session.dispatch(UP);
    const browsing = view(session);
    expect(browsing).toContain("draft answer");
    // The row shows what was typed, not the placeholder inviting them to type.
    expect(browsing).not.toContain("Type something.");
    session.dispatch(DOWN);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: "draft answer" }],
      cancelled: false,
    });
  });

  it("composes a multiline answer with the configured newline key", () => {
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch("first line");
    session.dispatch(SHIFT_ENTER);
    session.dispatch("second line");
    expect(view(session)).toContain("second line");
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
      cancelled: false,
    });
  });

  it("moves the cursor inside the draft, then resumes row navigation at its edge", () => {
    // Up on the second line moves within the text; up again has nowhere left to
    // go inside the editor, so it goes back to browsing rows.
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch("first");
    session.dispatch(SHIFT_ENTER);
    session.dispatch("second");
    session.dispatch(UP);
    session.dispatch("!");
    session.dispatch(UP);
    session.dispatch(DOWN);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
      cancelled: false,
    });
  });

  it("clears the draft with the user's line-kill binding", () => {
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch("discard me");
    session.dispatch(CTRL_U);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: null })],
      cancelled: false,
    });
  });

  it("keeps each question's draft separate across tab switches", () => {
    const multi: QuestionParams = {
      questions: [
        {
          ...(params.questions[0] as QuestionParams["questions"][number]),
          question: "First?",
          header: "First",
        },
        {
          ...(params.questions[0] as QuestionParams["questions"][number]),
          question: "Second?",
          header: "Second",
        },
      ],
    };
    const { session } = makeSession({ params: multi });

    focusCustomAnswer(session);
    session.dispatch("first");
    session.dispatch(UP);
    session.dispatch(DOWN);
    session.dispatch("-latest");
    session.dispatch(ENTER);

    focusCustomAnswer(session);
    session.dispatch("second");
    session.dispatch(UP);
    session.dispatch(TAB);
    session.dispatch(TAB);
    expect(view(session)).toContain("first-latest");
    session.dispatch(TAB);
    expect(view(session)).toContain("second");
  });
});

/**
 * The editors are constructed with submit disabled. Without it, a keystroke
 * matching a submit binding inside the editor's own handler calls
 * `submitValue()`, which resets the buffer -- and nothing is wired to
 * `onSubmit` here, so the text is simply gone.
 */
describe("the draft cannot be destroyed by the editor's own submit handling", () => {
  it("survives a raw Enter byte the router does not claim", () => {
    // The router here matches only the <ENTER> sentinel, so "\r" reaches the
    // editor, whose global bindings still map Enter to submit.
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch("precious draft");
    session.dispatch("\r");
    expect(view(session)).toContain("precious draft");
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
      cancelled: false,
    });
  });

  it("commits through a remapped submit key rather than falling into the editor", () => {
    // A Slack-style config: Enter makes a newline, submit lives elsewhere. The
    // remapped key has to confirm the answer, not reach the editor.
    const CTRL_ENTER = "<CTRL_ENTER>";
    const remapped: typeof keybindings = {
      matches(data, name) {
        if (name === "tui.input.submit") return data === CTRL_ENTER;
        if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
        return keybindings.matches(data, name);
      },
    };
    const { session, done } = makeSession({ keybindings: remapped });
    focusCustomAnswer(session);
    session.dispatch("first line");
    session.dispatch(SHIFT_ENTER);
    session.dispatch("second line");
    session.dispatch(CTRL_ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
      cancelled: false,
    });
  });

  it("keeps a notes draft through the same raw Enter", () => {
    const { session, done } = makeSession();
    session.dispatch("n");
    session.dispatch("a note");
    session.dispatch("\r");
    session.dispatch(ENTER);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ notes: expect.stringContaining("a note") })],
      cancelled: false,
    });
  });
});

describe("notes", () => {
  it("attaches a multiline note to the answer", () => {
    const { session, done } = makeSession();
    session.dispatch("n");
    session.dispatch("first note");
    session.dispatch(SHIFT_ENTER);
    session.dispatch("second note");
    session.dispatch(ENTER);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
      cancelled: false,
    });
  });
});

describe("the external editor", () => {
  it("replaces the draft with what came back", async () => {
    const editInput = vi.fn<(value: string) => Promise<string | undefined>>((value) =>
      Promise.resolve(`${value} + edited`),
    );
    const { session, done } = makeSession({ editInput });
    focusCustomAnswer(session);
    session.dispatch("draft");
    session.dispatch(CTRL_G);
    await settle();
    expect(editInput).toHaveBeenCalledWith("draft");
    session.dispatch(ENTER);
    expect(done).toHaveBeenLastCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
      cancelled: false,
    });
  });

  it("swallows every keystroke while it is open", async () => {
    // The terminal belongs to the editor. Keys typed into it must not also be
    // routed into the dialog behind it.
    let resolveEditor!: (value: string | undefined) => void;
    const editInput = vi.fn<() => Promise<string | undefined>>(
      () => new Promise<string | undefined>((resolve) => (resolveEditor = resolve)),
    );
    const { session, done } = makeSession({ editInput });
    focusCustomAnswer(session);
    session.dispatch("draft");
    session.dispatch(CTRL_G);

    session.dispatch(UP);
    session.dispatch("late input");
    resolveEditor("edited");
    await settle();
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
      cancelled: false,
    });
  });

  it("keeps the draft when the launch failed", async () => {
    // Losing what the user typed because their editor is misconfigured would be
    // the worst possible response to a misconfigured editor.
    const { session, done } = makeSession({
      editInput: () => Promise.reject(new Error("no editor")),
    });
    focusCustomAnswer(session);
    session.dispatch("still here");
    session.dispatch(CTRL_G);
    await settle();
    expect(view(session)).toContain("still here");
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: "still here" })],
      cancelled: false,
    });
  });

  it("keeps the draft when the editor resolved with nothing", async () => {
    const { session, done } = makeSession({ editInput: () => Promise.resolve(undefined) });
    focusCustomAnswer(session);
    session.dispatch("still here");
    session.dispatch(CTRL_G);
    await settle();
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: "still here" })],
      cancelled: false,
    });
  });

  it("takes input again once it closes", async () => {
    const { session } = makeSession({ editInput: () => Promise.resolve("edited") });
    focusCustomAnswer(session);
    session.dispatch(CTRL_G);
    await settle();
    session.dispatch(" and more");
    expect(view(session)).toContain("edited and more");
  });

  it("launches only once however many times the key is pressed", async () => {
    // Suspended dispatch is what stops the second press; the guard inside the
    // launch itself is defensive depth behind it.
    const editInput = vi.fn<() => Promise<string | undefined>>(
      () => new Promise<string | undefined>(() => {}),
    );
    const { session } = makeSession({ editInput });
    focusCustomAnswer(session);
    session.dispatch(CTRL_G);
    session.dispatch(CTRL_G);
    session.dispatch(CTRL_G);
    await settle();
    expect(editInput).toHaveBeenCalledTimes(1);
  });

  it("refuses to collapse while it is open", async () => {
    // Hiding the overlay out from under an editor the user is typing in would
    // leave them with nothing to come back to.
    const { session } = makeSession({ editInput: () => new Promise<string | undefined>(() => {}) });
    focusCustomAnswer(session);
    session.dispatch(CTRL_G);
    session.toggleCollapsedExternal();
    await settle();
    expect(session.component.render(120).length).toBeGreaterThan(1);
  });
});

describe("collapsing", () => {
  it("shrinks to a single row that names the key to come back", () => {
    const { session } = makeSession({ collapseKey: "ctrl+]" });
    session.toggleCollapsedExternal();
    const collapsed = session.component.render(120);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("Ctrl+] to expand");
    expect(collapsed[0]).toContain("Esc to cancel");
  });

  it("advertises no key when the shortcut is off", () => {
    // The router never collapses with the shortcut off, but this entry point is
    // public and ungated, so the row must not tell the user to press "Off".
    const { session } = makeSession({ collapseKey: "off" });
    session.toggleCollapsedExternal();
    const collapsed = session.component.render(120);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("Esc to cancel");
    expect(collapsed[0]).not.toContain("to expand");
    expect(collapsed[0]).not.toContain("Off");
  });

  it("expands again on a second toggle", () => {
    const { session } = makeSession({ collapseKey: "ctrl+]" });
    session.toggleCollapsedExternal();
    session.toggleCollapsedExternal();
    expect(session.component.render(120).length).toBeGreaterThan(1);
  });
});

/**
 * Whether the overlay is really hidden, as opposed to merely rendering one row,
 * is gated on there being a raw terminal listener. Pi routes no input to a
 * hidden overlay, so on a host without one, hiding would put the dialog
 * somewhere nothing can bring it back from.
 */
describe("hiding the overlay", () => {
  function makeHandle(): OverlayHandle & { setHidden: ReturnType<typeof vi.fn> } {
    return { setHidden: vi.fn<(hidden: boolean) => void>() } as unknown as OverlayHandle & {
      setHidden: ReturnType<typeof vi.fn>;
    };
  }

  it("hides the overlay when the collapse key can reach it again", () => {
    const { session } = makeSession({ collapseKey: "ctrl+]", canReopenWhileHidden: true });
    const handle = makeHandle();
    session.setOverlayHandle(handle);
    session.toggleCollapsedExternal();
    expect(handle.setHidden).toHaveBeenCalledWith(true);
    session.toggleCollapsedExternal();
    expect(handle.setHidden).toHaveBeenLastCalledWith(false);
  });

  it("refuses to hide when nothing could reopen it", () => {
    // The visible one-line row is the fallback: it keeps focus and keeps
    // receiving keys, so the user can always get back.
    const { session } = makeSession({ collapseKey: "ctrl+]", canReopenWhileHidden: false });
    const handle = makeHandle();
    session.setOverlayHandle(handle);
    session.toggleCollapsedExternal();
    expect(handle.setHidden).not.toHaveBeenCalled();
    expect(session.component.render(120)).toHaveLength(1);
  });

  it("still tracks the collapsed state before the handle arrives", () => {
    // The handle turns up in a callback after the overlay exists, so a collapse
    // in that window must not be lost.
    const { session } = makeSession({ collapseKey: "ctrl+]", canReopenWhileHidden: true });
    session.toggleCollapsedExternal();
    expect(session.component.render(120)).toHaveLength(1);
    const handle = makeHandle();
    session.setOverlayHandle(handle);
    session.toggleCollapsedExternal();
    expect(handle.setHidden).toHaveBeenCalledWith(false);
  });
});

/**
 * A large paste is collapsed by the editor into a marker like
 * `[paste #1 +20 lines]`, and restoring a draft goes through `setText`, which
 * clears the paste map that marker points into. So every read of a buffer that
 * might be stored and restored has to be the expanded one, or the text comes
 * back as a reference to something that no longer exists.
 */
describe("pasted text", () => {
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  const pasted = Array.from({ length: 20 }, (_v, i) => `line ${i}`).join("\n");

  it("commits the pasted text, not the marker standing in for it", () => {
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch(PASTE_START + pasted + PASTE_END);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ kind: "custom", answer: pasted })],
      cancelled: false,
    });
  });

  it("keeps pasted text through a trip away from the row and back", () => {
    // The round trip is what stores and restores the draft, which is where a
    // marker would be orphaned.
    const { session, done } = makeSession();
    focusCustomAnswer(session);
    session.dispatch(PASTE_START + pasted + PASTE_END);
    session.dispatch(UP);
    session.dispatch(DOWN);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: pasted })],
      cancelled: false,
    });
  });

  it("keeps a pasted note through the same round trip", () => {
    const { session, done } = makeSession();
    session.dispatch("n");
    session.dispatch(PASTE_START + pasted + PASTE_END);
    session.dispatch(ENTER);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ notes: pasted })],
      cancelled: false,
    });
  });
});

describe("keystrokes the router does not claim", () => {
  it("do not reach the custom-answer buffer while the user is browsing rows", () => {
    const { session, done } = makeSession();
    session.dispatch("stray");
    focusCustomAnswer(session);
    session.dispatch("typed here");
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [expect.objectContaining({ answer: "typed here" })],
      cancelled: false,
    });
  });

  it("do not cost a render while the user is browsing rows", () => {
    // Focusing the custom row restores its stored draft, so stray text typed
    // while browsing gets overwritten and never shows up in an answer. What it
    // does cost without the guard is a full re-render per keystroke, which is
    // the part that stays observable.
    const { session, requestRender } = makeSession();
    requestRender.mockClear();
    session.dispatch("no one asked for this");
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("still reach the buffer once the custom row has focus", () => {
    // The other half of the guard: it must not swallow real typing.
    const { session, requestRender } = makeSession();
    focusCustomAnswer(session);
    requestRender.mockClear();
    session.dispatch("x");
    expect(requestRender).toHaveBeenCalled();
    expect(view(session)).toContain("x");
  });
});

describe("finishing", () => {
  it("reports a cancel when the user presses the cancel key", () => {
    const { session, done } = makeSession();
    session.dispatch(ESC);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
  });

  it("answers with the chosen option's label", () => {
    const { session, done } = makeSession();
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith({
      answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "A" }],
      cancelled: false,
    });
  });
});
