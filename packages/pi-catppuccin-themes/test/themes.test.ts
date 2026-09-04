import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Theme correctness guard. Pi resolves each `colors` value either as a `vars`
 * key or as a literal hex color, so a typo in either table silently renders
 * the wrong color. These tests pin the contract: the full 26-role Catppuccin
 * palette per flavor, and every role reference resolving to something real.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FLAVORS = ["frappe", "latte", "macchiato", "mocha"] as const;
type Flavor = (typeof FLAVORS)[number];

/** The 26 official Catppuccin palette roles every flavor must define. */
const PALETTE_ROLES = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
  "text",
  "subtext1",
  "subtext0",
  "overlay2",
  "overlay1",
  "overlay0",
  "surface2",
  "surface1",
  "surface0",
  "base",
  "mantle",
  "crust",
] as const;

interface ThemeFile {
  $schema: string;
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: Record<string, string>;
}

function readTheme(flavor: Flavor): ThemeFile {
  const raw = readFileSync(join(packageRoot, "themes", `catppuccin-${flavor}.json`), "utf8");
  return JSON.parse(raw) as ThemeFile;
}

function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

describe("pi-catppuccin-themes flavors", () => {
  it.each(FLAVORS)("catppuccin-%s names itself after its file", (flavor) => {
    expect(readTheme(flavor).name).toBe(`catppuccin-${flavor}`);
  });

  it.each(FLAVORS)("catppuccin-%s defines the full 26-role palette in hex", (flavor) => {
    const { vars } = readTheme(flavor);
    expect(Object.keys(vars).sort()).toEqual([...PALETTE_ROLES].sort());
    for (const role of PALETTE_ROLES) {
      expect(isHex(vars[role] ?? "")).toBe(true);
    }
  });

  it.each(FLAVORS)("catppuccin-%s resolves every color and export reference", (flavor) => {
    // Each value is either a vars key or a literal hex color. Anything else
    // (a typo, a renamed role) renders wrong with no error from Pi.
    const theme = readTheme(flavor);
    const refs = { ...theme.colors, ...theme.export };
    expect(Object.keys(refs).length).toBeGreaterThan(50);
    for (const [key, value] of Object.entries(refs)) {
      expect(
        value in theme.vars || isHex(value),
        `${flavor}.${key} = ${value} resolves to neither a palette role nor hex`,
      ).toBe(true);
    }
  });

  it.each(FLAVORS)(
    "catppuccin-%s keeps the delta-mix tool backgrounds as literal hex",
    (flavor) => {
      // Design note, pinned: toolSuccessBg/toolErrorBg follow the
      // catppuccin/delta convention (subtle 20% color mixes), so they are
      // stored as literal hex, never as palette references.
      const { colors } = readTheme(flavor);
      expect(isHex(colors["toolSuccessBg"] ?? "")).toBe(true);
      expect(isHex(colors["toolErrorBg"] ?? "")).toBe(true);
    },
  );
});
