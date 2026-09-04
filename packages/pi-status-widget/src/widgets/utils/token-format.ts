export function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${trimFixed(value / 1000, 1)}k`;
  return `${trimFixed(value / 1_000_000, 1)}m`;
}

/** Pi's own rounding for token counts, so a footer segment matches pi's display. */
export function formatPiTokenCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

const TOKEN_FORMATTERS = {
  default: formatCount,
  compact: formatPiTokenCount,
} as const;

export type TokenFormatStyle = keyof typeof TOKEN_FORMATTERS;

export function formatTokenCount(value: number, style: TokenFormatStyle): string {
  return TOKEN_FORMATTERS[style](value);
}

export function tokenFormatStyleProperty() {
  return {
    id: "tokenFormatStyle",
    kind: "choice",
    default: "default",
    choices: Object.keys(TOKEN_FORMATTERS) as readonly TokenFormatStyle[],
  } as const;
}
