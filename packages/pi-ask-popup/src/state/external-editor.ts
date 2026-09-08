import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The slice of the TUI this needs: the terminal has to be handed over and taken back. */
export interface ExternalEditorTui {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
}

/**
 * Split the command the way Pi's own external-editor flow does, and hand the
 * file over as the last argument.
 *
 * The grammar is deliberately the same as Pi's rather than better. Someone who
 * has `EDITOR="code --wait"` working in Pi expects Ctrl+G here to behave
 * identically; a separate shell or argv parser would make the same setting mean
 * two different things depending on which editor opened.
 */
function runEditor(command: string, file: string): Promise<void> {
  const [editor, ...args] = command.split(" ");
  // Unreachable given the caller's check, but the destructure is typed as
  // possibly-undefined and a bare assertion here would be worse.
  if (!editor) {
    return Promise.reject(new Error("External editor command is empty"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(editor, [...args, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`External editor exited with ${reason}`));
    });
  });
}

/**
 * Edit an answer in the user's configured editor and return what they saved.
 *
 * The TUI has to be stopped for the duration: the editor takes over the
 * terminal, and two programs drawing to it at once produces garbage neither can
 * clean up. Restarting it is in a `finally` for the same reason — a crashed
 * editor, a failed temp write, anything at all must not leave the user in a
 * stopped TUI with no way back.
 *
 * Every filesystem step is async. The TUI is stopped anyway, so nothing here is
 * painting, but the event loop is shared with the rest of Pi and blocking it on
 * a temp write over a slow or network-backed `TMPDIR` stalls every other
 * extension in the process.
 *
 * One trailing newline is stripped, matching Pi's main editor flow: most editors
 * add one on save, and keeping it would silently append a blank line to every
 * answer that went through here.
 */
export async function editWithExternalEditor(
  tui: ExternalEditorTui,
  command: string,
  value: string,
): Promise<string> {
  // Checked before anything is touched. Doing it inside `runEditor`, after the
  // TUI has already been stopped, makes a misconfigured editor command flash
  // the screen off and back on before reporting a problem that was knowable
  // from the start.
  if (command.trim().length === 0) {
    throw new Error("External editor command is empty");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-ask-popup-"));
  const tempFile = join(tempDir, "answer.md");
  let tuiStopped = false;

  try {
    await writeFile(tempFile, value, "utf8");
    tui.stop();
    tuiStopped = true;
    process.stdout.write(
      `Launching external editor: ${command}\nPi will resume when the editor exits.\n`,
    );
    await runEditor(command, tempFile);
    return (await readFile(tempFile, "utf8")).replace(/\r?\n$/, "");
  } finally {
    // The terminal comes back before the cleanup, not after. Both are in the
    // finally, but a slow or wedged unlink must not be what stands between the
    // user and a working screen.
    if (tuiStopped) {
      tui.start();
      tui.requestRender(true);
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort. A temp directory left behind is a nuisance; a failed
      // cleanup that propagated would replace the answer with an error.
    }
  }
}
