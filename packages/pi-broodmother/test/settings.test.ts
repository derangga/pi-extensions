import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  decodeSettings,
  loadSettings,
  saveSettings,
  type SubagentSettings,
} from "../src/settings.js";

async function tempFile(name = "pi-broodmother.json"): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pi-broodmother-")), name);
}

describe("decodeSettings", () => {
  it("keeps every good field and drops only the bad one", () => {
    const { settings, warnings } = decodeSettings({
      model: "claude-opus-5",
      thinking: "high",
      concurrency: 99,
      maxTurns: 50,
    });

    expect(settings.model).toBe("claude-opus-5");
    expect(settings.thinking).toBe("high");
    expect(settings.maxTurns).toBe(50);
    // The out-of-range field alone falls back.
    expect(settings.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("concurrency");
  });

  it("takes either permission and defaults a missing one to read-only", () => {
    expect(decodeSettings({ permissions: "read-write" }).settings.permissions).toBe("read-write");
    expect(decodeSettings({ permissions: "read-only" }).settings.permissions).toBe("read-only");
    // The safe side is what an older file, written before the field existed, gets.
    expect(decodeSettings({ model: "claude-opus-5" }).settings.permissions).toBe("read-only");
    expect(decodeSettings({ permissions: "read-write" }).warnings).toEqual([]);
  });

  it("falls back to read-only on a permission it does not recognise", () => {
    for (const raw of ["readwrite", "write", "rw", true, 1, null]) {
      const { settings, warnings } = decodeSettings({ permissions: raw });
      expect(settings.permissions).toBe("read-only");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("permissions");
    }
  });

  it("rejects a thinking level that is not one of pi's", () => {
    const { settings, warnings } = decodeSettings({ thinking: "banana" });
    expect(settings.thinking).toBe(DEFAULT_SETTINGS.thinking);
    expect(warnings).toHaveLength(1);
  });

  it("rejects a fractional concurrency", () => {
    expect(decodeSettings({ concurrency: 2.5 }).settings.concurrency).toBe(
      DEFAULT_SETTINGS.concurrency,
    );
  });

  it("accepts the bounds and rejects just outside them", () => {
    expect(decodeSettings({ concurrency: 1 }).settings.concurrency).toBe(1);
    expect(decodeSettings({ concurrency: 8 }).settings.concurrency).toBe(8);
    expect(decodeSettings({ concurrency: 0 }).warnings).toHaveLength(1);
    expect(decodeSettings({ concurrency: 9 }).warnings).toHaveLength(1);
    expect(decodeSettings({ maxTasks: 1 }).settings.maxTasks).toBe(1);
    expect(decodeSettings({ maxTasks: 16 }).settings.maxTasks).toBe(16);
    expect(decodeSettings({ maxTasks: 0 }).warnings).toHaveLength(1);
    expect(decodeSettings({ maxTasks: 17 }).warnings).toHaveLength(1);
  });

  it("leaves absent fields at their defaults without warning", () => {
    const { settings, warnings } = decodeSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });

  it("falls back whole when the file is not an object", () => {
    for (const raw of ["oops", 42, null, [1, 2]]) {
      const { settings, warnings } = decodeSettings(raw);
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("loadSettings", () => {
  it("treats a missing file as the first run, silently", async () => {
    const loaded = await Effect.runPromise(loadSettings(await tempFile("absent.json")));
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.warnings).toEqual([]);
  });

  it("falls back and warns on a file that is not JSON", async () => {
    const path = await tempFile();
    await writeFile(path, "{ not json", "utf8");

    const loaded = await Effect.runPromise(loadSettings(path));
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.warnings[0]).toContain("not valid JSON");
  });

  it("round-trips through save", async () => {
    const path = await tempFile();
    const settings: SubagentSettings = {
      permissions: "read-write",
      model: "claude-sonnet-5",
      thinking: "low",
      concurrency: 5,
      maxTurns: 20,
      maxTasks: 8,
    };

    await Effect.runPromise(saveSettings(settings, path));
    const loaded = await Effect.runPromise(loadSettings(path));

    expect(loaded.settings).toEqual(settings);
    expect(loaded.warnings).toEqual([]);
    // Written where a person can find and edit it.
    expect(await readFile(path, "utf8")).toContain('"model": "claude-sonnet-5"');
    expect(await readFile(path, "utf8")).toContain('"permissions": "read-write"');
  });

  it("creates the directory it writes into", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pi-broodmother-")), "nested", "deep.json");
    await Effect.runPromise(saveSettings(DEFAULT_SETTINGS, path));
    expect((await Effect.runPromise(loadSettings(path))).settings).toEqual(DEFAULT_SETTINGS);
  });
});
