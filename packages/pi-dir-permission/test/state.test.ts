import { readGrants, sameGrants, STATE_TYPE } from "../src/state.js";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function entry(customType: string, data: unknown): SessionEntry {
  // SAFETY: test fixture with the shape the session manager replays.
  return {
    id: "e1",
    parentId: null,
    timestamp: "",
    type: "custom",
    customType,
    data,
  } as SessionEntry;
}

function snapshot(...paths: string[]): SessionEntry {
  return entry(STATE_TYPE, { dirs: paths.map((path) => ({ absolutePath: path, label: "x" })) });
}

describe("readGrants", () => {
  it("returns nothing for a branch that never granted anything", () => {
    expect(readGrants([])).toEqual([]);
    expect(
      readGrants([entry("something-else", { dirs: [{ absolutePath: "/a", label: "a" }] })]),
    ).toEqual([]);
  });

  it("takes the last snapshot on the branch", () => {
    const grants = readGrants([snapshot("/a"), snapshot("/a", "/b")]);
    expect(grants.map((grant) => grant.absolutePath)).toEqual(["/a", "/b"]);
  });

  it("reads a revocation, which is just a shorter snapshot", () => {
    expect(readGrants([snapshot("/a", "/b"), snapshot("/a")])).toHaveLength(1);
    expect(readGrants([snapshot("/a"), snapshot()])).toEqual([]);
  });

  it("skips entries it cannot make sense of instead of failing the session", () => {
    expect(readGrants([entry(STATE_TYPE, undefined), snapshot("/a")])).toHaveLength(1);
    expect(readGrants([entry(STATE_TYPE, { dirs: "not-an-array" })])).toEqual([]);
    expect(
      readGrants([entry(STATE_TYPE, { dirs: [{ absolutePath: "relative/path", label: "x" }] })]),
    ).toEqual([]);
    expect(readGrants([entry(STATE_TYPE, { dirs: [{ absolutePath: "/a" }, null, 7] })])).toEqual(
      [],
    );
  });

  it("copies the grants out, so a later push cannot reach the session entry", () => {
    const source = snapshot("/a");
    const grants = readGrants([source]);
    grants[0]!.absolutePath = "/mutated";
    expect(readGrants([source])[0]?.absolutePath).toBe("/a");
  });
});

describe("sameGrants", () => {
  it("compares the directories, in order", () => {
    const a = [{ absolutePath: "/a", label: "a" }];
    const b = [{ absolutePath: "/b", label: "b" }];
    expect(sameGrants(a, [...a])).toBe(true);
    expect(sameGrants(a, b)).toBe(false);
    expect(sameGrants([...a, ...b], [...b, ...a])).toBe(false);
    expect(sameGrants(a, [...a, ...b])).toBe(false);
  });
});
