import type { Theme } from "@earendil-works/pi-coding-agent";

// Pi Theme fixtures. The real Theme exposes many methods; these stubs carry
// only what the color layer touches, cast to Theme.

/** Wraps text in <color>…</color> so a test can assert which color was asked for. */
export const taggedTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

/**
 * Defines only the colors it is given and throws on the rest, matching the real
 * Theme, which throws on a color the loaded theme does not define. From Pi 0.84
 * both thinkingMax and searchMatchText are optional, so this is the shape of a
 * real installation rather than a hypothetical one.
 */
export function partialTheme(defined: readonly string[]): Theme {
  return {
    fg: (color: string, text: string) => {
      if (!defined.includes(color)) throw new Error(`Unknown theme color: ${color}`);
      return `<${color}>${text}</${color}>`;
    },
  } as unknown as Theme;
}
