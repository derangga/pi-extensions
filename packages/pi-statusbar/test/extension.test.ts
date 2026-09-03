import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asyncCache } from "../src/cache.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import statusbarExtension from "../src/index.js";
import { taggedTheme } from "./helpers/theme.js";
import {
  stubApi,
  stubContext,
  stubFooterData,
  stubTui,
  type ApiStub,
  type ContextOptions,
  type ContextStub,
  type FooterFactory,
} from "./helpers/pi.js";

const CONFIG_ENV = "PI_STATUSBAR_CONFIG";
let configPath: string;
let previousConfigPath: string | undefined;

beforeEach(async () => {
  asyncCache.clear();
  previousConfigPath = process.env[CONFIG_ENV];
  // A path inside a fresh directory that does not exist yet: the missing-file
  // branch, which is the normal first run. Tests that want a file write one.
  const dir = await mkdtemp(join(tmpdir(), "pi-statusbar-"));
  configPath = join(dir, "pi-statusbar.json");
  process.env[CONFIG_ENV] = configPath;
});

afterEach(() => {
  if (previousConfigPath === undefined) delete process.env[CONFIG_ENV];
  else process.env[CONFIG_ENV] = previousConfigPath;
});

/** Loads the extension and starts a session, which is what mounts the footer. */
async function start(
  options: ContextOptions = {},
): Promise<{ api: ApiStub; context: ContextStub }> {
  const api = stubApi();
  const context = stubContext(options);
  await statusbarExtension(api.pi);
  await api.fire("session_start", context.ctx);
  return { api, context };
}

function mount(factory: FooterFactory | undefined) {
  if (!factory) throw new Error("no footer factory was registered");
  const tui = stubTui();
  const footerData = stubFooterData();
  return { tui, footerData, component: factory(tui.tui, taggedTheme, footerData.footerData) };
}

describe("statusbarExtension wiring", () => {
  it("subscribes to the events that drive the footer", async () => {
    const api = stubApi();
    await statusbarExtension(api.pi);

    expect([...api.handlers.keys()].sort()).toEqual([
      "model_select",
      "session_shutdown",
      "session_start",
      "thinking_level_select",
    ]);
  });

  it("publishes its status and mounts a footer on session start", async () => {
    const { context } = await start();

    expect(context.statuses).toEqual(["<accent>pi-statusbar</accent>"]);
    expect(context.footers).toHaveLength(1);
    expect(context.footers[0]).toBeTypeOf("function");
  });

  it("remounts on a model change", async () => {
    const { api, context } = await start();
    await api.fire("model_select", context.ctx);

    expect(context.footers).toHaveLength(2);
  });

  it("clears both the footer and the status without a UI", async () => {
    const { context } = await start({ hasUI: false });

    expect(context.footers).toEqual([undefined]);
    expect(context.statuses).toEqual([undefined]);
  });

  it("clears both when the config disables the footer", async () => {
    await writeFile(configPath, JSON.stringify({ ...DEFAULT_CONFIG, enabled: false }), "utf8");
    const { context } = await start();

    expect(context.footers).toEqual([undefined]);
    expect(context.statuses).toEqual([undefined]);
  });

  it("clears both on session shutdown", async () => {
    const { api, context } = await start();
    await api.fire("session_shutdown", context.ctx);

    expect(context.footers.at(-1)).toBeUndefined();
    expect(context.statuses.at(-1)).toBeUndefined();
  });

  it("reports an unreadable config once, then stops", async () => {
    await writeFile(configPath, "{ not json", "utf8");
    const { api, context } = await start();

    expect(context.notifications).toHaveLength(1);
    expect(context.notifications[0]?.message).toContain("not valid JSON");
    expect(context.notifications[0]?.type).toBe("warning");

    await api.fire("model_select", context.ctx);
    expect(context.notifications).toHaveLength(1);
  });
});

describe("statusbarExtension repaint triggers", () => {
  it("repaints when the thinking level changes", async () => {
    const { api, context } = await start();
    const { tui } = mount(context.footers[0]);

    await api.fire("thinking_level_select", context.ctx, {
      type: "thinking_level_select",
      level: "max",
      previousLevel: "high",
    });

    expect(tui.renderRequests).toBe(1);
  });

  it("does nothing on a level change with no footer mounted", async () => {
    const { api, context } = await start({ hasUI: false });

    await expect(
      api.fire("thinking_level_select", context.ctx, { type: "thinking_level_select" }),
    ).resolves.toBeUndefined();
  });

  it("repaints when the branch changes", async () => {
    const { context } = await start();
    const { tui, footerData } = mount(context.footers[0]);

    footerData.changeBranch();

    expect(tui.renderRequests).toBe(1);
  });

  it("stops listening for branch changes once disposed", async () => {
    const { context } = await start();
    const { tui, footerData, component } = mount(context.footers[0]);

    component.dispose?.();
    footerData.changeBranch();

    expect(footerData.unsubscribeCount).toBe(1);
    expect(tui.renderRequests).toBe(0);
  });

  it("keeps the live footer repainting when a replaced one disposes late", async () => {
    // Pi mounts the new footer before disposing the old one. A dispose that
    // dropped the captured handle unconditionally would leave the mounted
    // footer deaf to a level change, which is exactly the segment this package
    // exists to colour.
    const { api, context } = await start();
    const first = mount(context.footers[0]);

    await api.fire("model_select", context.ctx);
    const second = mount(context.footers[1]);
    first.component.dispose?.();

    await api.fire("thinking_level_select", context.ctx, { type: "thinking_level_select" });

    expect(second.tui.renderRequests).toBe(1);
    expect(first.tui.renderRequests).toBe(0);
  });
});

describe("statusbarExtension rendering", () => {
  it("draws the configured widgets", async () => {
    const { context } = await start();
    const { component } = mount(context.footers[0]);

    const lines = component.render(120);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("opus");
  });

  it("draws nothing at zero width", async () => {
    const { context } = await start();
    const { component } = mount(context.footers[0]);

    expect(component.render(0)).toEqual([]);
  });

  it("appends another extension's status below the footer", async () => {
    const { context } = await start();
    const factory = context.footers[0];
    if (!factory) throw new Error("no footer factory was registered");

    const tui = stubTui();
    const footerData = stubFooterData("main", new Map([["other-extension", "busy"]]));
    const component = factory(tui.tui, taggedTheme, footerData.footerData);

    const lines = component.render(120);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("busy");
  });
});
