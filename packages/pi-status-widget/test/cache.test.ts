import { describe, expect, it, vi } from "vitest";

import { AsyncCache } from "../src/cache.js";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Lets a test hold a fetch open and settle it on demand. */
function deferred<V>(): { promise: Promise<V>; resolve: (value: V) => void } {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("AsyncCache", () => {
  it("returns null on the first read and fetches behind it", async () => {
    const cache = new AsyncCache();
    const fetcher = vi.fn<() => Promise<string>>(async () => "value");

    expect(cache.get("key", 1000, {}, fetcher)).toBeNull();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(cache.get("key", 1000, {}, fetcher)).toBe("value");
  });

  it("serves a fresh value without fetching again", async () => {
    const time = clock();
    const cache = new AsyncCache(200, time.now);
    const fetcher = vi.fn<() => Promise<string>>(async () => "value");

    cache.get("key", 1000, {}, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    time.advance(999);
    expect(cache.get("key", 1000, {}, fetcher)).toBe("value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a stale value immediately and refreshes behind it", async () => {
    const time = clock();
    const cache = new AsyncCache(200, time.now);
    let next = "first";
    const fetcher = vi.fn<() => Promise<string>>(async () => next);

    cache.get("key", 1000, {}, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    time.advance(1000);
    next = "second";
    // The stale value comes back on the spot; the caller never waits.
    expect(cache.get("key", 1000, {}, fetcher)).toBe("first");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(cache.get("key", 1000, {}, fetcher)).toBe("second");
  });

  it("runs one fetch for concurrent reads of the same key", async () => {
    const cache = new AsyncCache();
    const pending = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>(() => pending.promise);

    cache.get("key", 1000, {}, fetcher);
    cache.get("key", 1000, {}, fetcher);
    cache.get("key", 1000, {}, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    pending.resolve("value");
    await vi.waitFor(() => expect(cache.get("key", 1000, {}, fetcher)).toBe("value"));
  });

  it("keys entries separately", async () => {
    const cache = new AsyncCache();
    const fetcher = vi.fn<(filter: string) => Promise<string>>(async (filter) => filter);

    cache.get("left", 1000, "left", fetcher);
    cache.get("right", 1000, "right", fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(cache.get("left", 1000, "left", fetcher)).toBe("left");
    expect(cache.get("right", 1000, "right", fetcher)).toBe("right");
  });

  it("notifies each waiting listener once, then forgets them", async () => {
    const cache = new AsyncCache();
    const pending = deferred<string>();
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();

    cache.get("key", 1000, {}, () => pending.promise, first);
    cache.get("key", 1000, {}, () => pending.promise, second);
    pending.resolve("value");

    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("caches null when the fetcher rejects, and still notifies", async () => {
    const cache = new AsyncCache();
    const onRefresh = vi.fn<() => void>();

    cache.get(
      "key",
      1000,
      {},
      async () => {
        throw new Error("boom");
      },
      onRefresh,
    );

    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(cache.get("key", 1000, {}, async () => "value")).toBeNull();
  });

  it("keeps notifying after a listener throws", async () => {
    const cache = new AsyncCache();
    const pending = deferred<string>();
    const survivor = vi.fn<() => void>();

    cache.get(
      "key",
      1000,
      {},
      () => pending.promise,
      () => {
        throw new Error("listener blew up");
      },
    );
    cache.get("key", 1000, {}, () => pending.promise, survivor);
    pending.resolve("value");

    await vi.waitFor(() => expect(survivor).toHaveBeenCalledTimes(1));
  });

  it("evicts the oldest entry once it is over its limit", async () => {
    const cache = new AsyncCache(2);
    const fetcher = vi.fn<(filter: string) => Promise<string>>(async (filter) => filter);

    for (const key of ["a", "b", "c"]) cache.get(key, 1000, key, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));

    expect(cache.get("a", 1000, "a", fetcher)).toBeNull();
    expect(cache.get("c", 1000, "c", fetcher)).toBe("c");
  });

  it("drops everything on clear", async () => {
    const cache = new AsyncCache();
    const fetcher = vi.fn<() => Promise<string>>(async () => "value");

    cache.get("key", 1000, {}, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    cache.clear();
    expect(cache.get("key", 1000, {}, fetcher)).toBeNull();
  });
});
