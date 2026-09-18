/**
 * Running a shell command under the jail.
 *
 * Pi's own bash tool takes a `spawnHook` that can rewrite the command before it
 * spawns, and `createLocalBashOperations` exists for extensions that want the
 * host's shell behaviour while rewriting commands. So this module rewrites a
 * command string and nothing else: no child processes, no stdio handling, no
 * waiting on descendants that hold the pipes open after exit. The host keeps
 * owning all of that.
 */
import { jailCommand, type Jail } from "./profile.js";

/** POSIX single-quoting. The only way out of a single-quoted string is to close it. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command to hand the host instead of `command`, jailed if there is a jail.
 * The result runs one extra shell: the host spawns `shell -c <this>`, and this
 * spawns the jail, which spawns `shell -c <original>`.
 */
export function wrapCommand(jail: Jail | undefined, command: string, shellPath: string): string {
  const invocation = jailCommand(jail, shellPath, ["-c", command]);
  if (invocation === undefined) {
    return command;
  }
  // Every argument is quoted, flags included. Quoting a flag does not change
  // it, and the alternative is a rule for telling a flag from a command, which
  // a command like `--help` defeats.
  return [invocation.file, ...invocation.args.map(quote)].join(" ");
}
