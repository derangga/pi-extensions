import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWithExternalEditor } from "../src/state/external-editor.js";

/**
 * These run a real child process. A mocked `spawn` would prove only that the
 * mock was called, and the things worth checking here -- that the file round
 * trips, that a non-zero exit is reported, that the TUI comes back either way
 * -- are exactly the things a mock would assume.
 */

let fixtureDir: string;
let stdout: ReturnType<typeof vi.spyOn>;

function makeTui() {
  return {
    stop: vi.fn<() => void>(),
    start: vi.fn<() => void>(),
    requestRender: vi.fn<() => void>(),
  };
}

function editorThatWrites(body: string): string {
  const path = join(fixtureDir, `editor-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, body);
  return `${process.execPath} ${path}`;
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "pi-ask-popup-editor-test-"));
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdout.mockRestore();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("editWithExternalEditor", () => {
  it("round-trips the answer through the editor", async () => {
    const command = editorThatWrites(
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "edited answer\\n");',
    );
    const tui = makeTui();
    expect(await editWithExternalEditor(tui, command, "draft")).toBe("edited answer");
  });

  it("hands the terminal over and takes it back", async () => {
    // Two programs drawing to one terminal produces garbage neither can clean
    // up, so the TUI has to be stopped for the duration.
    const command = editorThatWrites("process.exit(0);");
    const tui = makeTui();
    await editWithExternalEditor(tui, command, "draft");
    expect(tui.stop).toHaveBeenCalledTimes(1);
    expect(tui.start).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("passes the current draft in as the file's starting content", async () => {
    const command = editorThatWrites(
      'import { readFileSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").toUpperCase());',
    );
    expect(await editWithExternalEditor(makeTui(), command, "shout this")).toBe("SHOUT THIS");
  });

  it("strips exactly one trailing newline, which is what editors add on save", async () => {
    const command = editorThatWrites(
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "line\\n\\n");',
    );
    // One newline goes, the deliberate blank line stays.
    expect(await editWithExternalEditor(makeTui(), command, "")).toBe("line\n");
  });

  it("handles a CRLF line ending the same way", async () => {
    const command = editorThatWrites(
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "line\\r\\n");',
    );
    expect(await editWithExternalEditor(makeTui(), command, "")).toBe("line");
  });

  it("keeps arguments in the editor command", async () => {
    // `EDITOR="code --wait"` has to mean the same thing here as it does in Pi,
    // or the same setting behaves two different ways.
    const path = join(fixtureDir, "argv-editor.mjs");
    writeFileSync(
      path,
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[3], process.argv[2]);',
    );
    const result = await editWithExternalEditor(
      makeTui(),
      `${process.execPath} ${path} --flag-value`,
      "",
    );
    expect(result).toBe("--flag-value");
  });

  it("reports a non-zero exit and still restores the TUI", async () => {
    const tui = makeTui();
    await expect(
      editWithExternalEditor(tui, editorThatWrites("process.exit(7);"), "draft"),
    ).rejects.toThrow("exit code 7");
    expect(tui.start).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("restores the TUI when the editor cannot be launched at all", async () => {
    // The failure mode that matters most: leaving the user in a stopped TUI
    // with no way back is worse than losing the edit.
    const tui = makeTui();
    await expect(
      editWithExternalEditor(tui, join(fixtureDir, "does-not-exist"), "draft"),
    ).rejects.toThrow(/ENOENT|spawn/);
    expect(tui.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects a %s command without touching the terminal", async (_label, command) => {
    // Knowable before anything is handed over, so the screen should not flash
    // off and back on to report it.
    const tui = makeTui();
    await expect(editWithExternalEditor(tui, command, "draft")).rejects.toThrow("command is empty");
    expect(tui.stop).not.toHaveBeenCalled();
    expect(tui.start).not.toHaveBeenCalled();
  });

  it("leaves no temp directory behind, on success or failure", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("pi-ask-popup-")).length;
    await editWithExternalEditor(makeTui(), editorThatWrites("process.exit(0);"), "draft");
    await editWithExternalEditor(makeTui(), editorThatWrites("process.exit(3);"), "draft").catch(
      () => {},
    );
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("pi-ask-popup-")).length;
    expect(after).toBe(before);
  });

  it("tells the user what is happening before the terminal goes quiet", async () => {
    // The screen is about to be taken over by another program; saying which one
    // is the difference between a pause and an apparent hang.
    await editWithExternalEditor(makeTui(), editorThatWrites("process.exit(0);"), "draft");
    const written = stdout.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("Launching external editor");
    expect(written).toContain("resume when the editor exits");
  });
});
