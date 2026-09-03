function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Wall clock since the first session entry. The caller passes the end, so the
 * footer reads a live value on each draw without a timer of its own.
 */
export function formatElapsed(first: number | undefined, last: number | undefined): string {
  if (first === undefined) return "0m";
  const end = last === undefined || last < first ? Date.now() : last;
  return formatDuration(end - first);
}
