import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LABELS_BY_KIND,
  RESERVED_LABEL_SET,
  ROW_INTENT_META,
  SENTINEL_KINDS,
  sentinelsToAppend,
} from "../src/state/row-intent.js";
import type { QuestionData } from "../src/tool/types.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function question(multiSelect: boolean): QuestionData {
  return {
    question: "Q?",
    header: "H",
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
    multiSelect,
  };
}

describe("sentinelsToAppend", () => {
  it("appends only the free-text row to a single-select question", () => {
    expect(sentinelsToAppend(question(false))).toEqual(["other"]);
  });

  it("appends the free-text row and the commit row to a multi-select question", () => {
    expect(sentinelsToAppend(question(true))).toEqual(["other", "next"]);
  });

  it("treats an absent multiSelect as single-select", () => {
    const q: QuestionData = { question: "Q?", header: "H", options: question(false).options };
    expect(sentinelsToAppend(q)).toEqual(["other"]);
  });

  it("returns kinds in SENTINEL_KINDS order", () => {
    const appended = sentinelsToAppend(question(true));
    const expectedOrder = SENTINEL_KINDS.filter((k) => appended.includes(k));
    expect(appended).toEqual(expectedOrder);
  });
});

describe("row intent metadata", () => {
  it("gives every sentinel a non-empty label and leaves option's empty", () => {
    // `option` labels are per-instance and come from the authored question, so
    // an empty label here is correct rather than an oversight.
    expect(ROW_INTENT_META.option.label).toBe("");
    for (const kind of SENTINEL_KINDS) {
      expect(ROW_INTENT_META[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("keeps LABELS_BY_KIND in step with the metadata table", () => {
    for (const kind of SENTINEL_KINDS) {
      expect(LABELS_BY_KIND[kind]).toBe(ROW_INTENT_META[kind].label);
    }
  });

  it("reserves every sentinel label plus 'Other'", () => {
    expect(RESERVED_LABEL_SET.has("Other")).toBe(true);
    for (const kind of SENTINEL_KINDS) {
      expect(RESERVED_LABEL_SET.has(ROW_INTENT_META[kind].label)).toBe(true);
    }
  });

  it("lets exactly one row open the inline editor", () => {
    // Two rows claiming inputMode would make focus ambiguous in the reducer.
    const activating = SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].activatesInputMode);
    expect(activating).toEqual(["other"]);
  });

  it("lets exactly one row commit a multi-select question", () => {
    const submitting = SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].autoSubmitsInMulti);
    expect(submitting).toEqual(["next"]);
  });

  it("never makes a row both toggleable and a commit command", () => {
    // Space on a row that also submits would toggle and commit at once.
    // Compared as whole lists rather than asserted inside a loop: a
    // conditional expect quietly asserts nothing when the branch never fires.
    const submitting = SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].autoSubmitsInMulti);
    const alsoBlockToggle = submitting.filter((k) => ROW_INTENT_META[k].blocksMultiToggle);
    expect(submitting.length).toBeGreaterThan(0);
    expect(alsoBlockToggle).toEqual(submitting);
  });
});

describe("discriminator discipline", () => {
  // Row and answer intent travels on a `kind` field. Parallel booleans were the
  // shape this design replaced: they permit states the union cannot express,
  // such as a row that is both `isOther` and `isNext`, and every consumer then
  // has to guess a precedence order.
  const BANNED = ["isOther", "isChat", "isNext", "wasCustom", "wasChat"] as const;

  function walkSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkSources(abs));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
    }
    return out;
  }

  it("no source file reintroduces a boolean intent flag", () => {
    const offenders: string[] = [];
    for (const file of walkSources(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      for (const flag of BANNED) {
        if (new RegExp(`\\b${flag}\\b`).test(text))
          offenders.push(`${relative(SRC_DIR, file)}: ${flag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually reads source files, so the check above can fail", () => {
    // Guards the guard: an empty or mis-rooted walk would pass forever.
    expect(walkSources(SRC_DIR).length).toBeGreaterThan(0);
  });
});
