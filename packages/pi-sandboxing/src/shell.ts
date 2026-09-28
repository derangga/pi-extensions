import { jailCommand, type Jail } from "./profile.js";

/** POSIX single-quoting. The only way out of a single-quoted string is to close it. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite one command through the selected OS backend. A blocked jail returns a
 * constant refusal and never includes the rejected command.
 */
export function wrapCommand(jail: Jail, command: string, shellPath: string): string {
  if (jail.state === "blocked") {
    return `printf '%s\\n' ${quote(`pi-sandboxing: ${jail.reason}`)} >&2; exit 126`;
  }
  const invocation = jailCommand(jail, shellPath, ["-c", command]);
  if (invocation === undefined) {
    return "printf '%s\\n' 'pi-sandboxing: invalid jail state' >&2; exit 126";
  }
  return [invocation.file, ...invocation.args].map(quote).join(" ");
}
