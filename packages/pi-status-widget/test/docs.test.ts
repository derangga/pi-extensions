import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COLOR_SCHEMES, SCHEME_NAMES } from "../src/schemes.js";

/**
 * Guards the parts of the README a reader is most likely to be misled by, and
 * that go stale silently: a scheme added to the table with no line about it, a
 * light-terminal scheme that fails to say so, or the truecolor requirement
 * getting edited away. Those are the support questions this feature will
 * generate, so they are worth pinning rather than trusting to review.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(packageRoot, "README.md"), "utf8");

const LIGHT_SUFFIX = " (light)";

/**
 * Whether the README marks a name as wanting a light terminal background.
 *
 * Every occurrence, not the first: a name is mentioned in the prose above the
 * list as well, and taking the first match would read the marking off the
 * wrong sentence.
 */
function markedLight(name: string): boolean {
  const quoted = `\`${name}\``;
  let at = readme.indexOf(quoted);
  while (at !== -1) {
    if (readme.slice(at + quoted.length).startsWith(LIGHT_SUFFIX)) return true;
    at = readme.indexOf(quoted, at + 1);
  }
  return false;
}

describe("the color scheme docs", () => {
  it("names every scheme the package ships", () => {
    // Walked, so a thirteenth scheme cannot arrive undocumented.
    const missing = SCHEME_NAMES.filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("marks the light-terminal schemes, and only those", () => {
    // Both directions. Asserting only that the light ones are marked would
    // pass just as well with every scheme labelled light.
    const marked = Object.fromEntries(SCHEME_NAMES.map((name) => [name, markedLight(name)]));
    const expected = Object.fromEntries(
      SCHEME_NAMES.map((name) => [name, COLOR_SCHEMES[name].light]),
    );
    expect(marked).toEqual(expected);
  });

  it("says the scheme recolors the footer and not pi's theme, and where that lives", () => {
    // Anyone who picks github-light and finds their editor unchanged has either
    // misread this or been misled by it.
    expect(readme).toContain("recolors this footer and nothing else");
    expect(readme).toContain("does not change pi's theme");
    expect(readme).toContain("/settings");
  });

  it("states the truecolor requirement and what happens below it", () => {
    // The likeliest support question by some distance: a scheme picked on a
    // 256-color terminal looks almost exactly like no scheme at all.
    expect(readme).toContain("truecolor");
    expect(readme).toContain("nearest of the basic 16");
    expect(readme).toMatch(/almost nothing changed, this is\s+why/);
  });

  it("says default means inherit and is the way back out", () => {
    expect(readme).toMatch(/`default` is the shipped value and means inherit/);
    expect(readme).toContain("way back out of a scheme");
  });

  it("explains that a widget fg names a slot the scheme defines", () => {
    expect(readme).toContain('`fg: "brightCyan"`');
    expect(readme).toContain("the active scheme decides");
  });

  it("carries no issue tracker ids, in the README or the docs it ships", () => {
    // A repo-wide rule: they rot, they mean nothing to someone reading the
    // published package, and they leak internal process into an install.
    const tracker = /\b[a-z][a-z0-9-]*-[0-9a-f]{3,}(\.\d+)?\b/g;
    expect(readme.match(tracker)).toBeNull();
  });
});
