interface CacheEntry<V> {
  value: V | null;
  updatedAt: number | null;
  pending: Promise<void> | null;
  listeners: Set<() => void>;
}

/**
 * Stale-while-revalidate store for values a render pass cannot wait on. A read
 * returns whatever is cached, including a stale value, and starts one refresh in
 * the background; the caller is told to repaint when fresh data lands.
 *
 * pi-footer namespaces the keys, since it caches project runtime detection
 * alongside git. Git is the only asynchronous collector this package ships, so
 * the key is the key.
 */
export class AsyncCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly maxEntries = 200,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get<V, F>(
    key: string,
    ttlMs: number,
    filter: F,
    fetcher: (filter: F) => Promise<V | null>,
    onRefresh?: () => void,
  ): V | null {
    const entry = this.entryFor<V>(key);
    if (this.isFresh(entry, ttlMs)) return entry.value;

    if (onRefresh) entry.listeners.add(onRefresh);
    // One refresh in flight per key. Concurrent reads join the pending one
    // instead of each spawning their own subprocesses.
    if (!entry.pending) entry.pending = this.refresh(entry, filter, fetcher);

    return entry.value;
  }

  clear(): void {
    this.entries.clear();
  }

  private entryFor<V>(key: string): CacheEntry<V> {
    const cached = this.entries.get(key);
    if (cached) return cached as CacheEntry<V>;

    const entry: CacheEntry<V> = {
      value: null,
      updatedAt: null,
      pending: null,
      listeners: new Set(),
    };
    this.entries.set(key, entry as CacheEntry<unknown>);
    this.evictOldestEntry();
    return entry;
  }

  private isFresh<V>(entry: CacheEntry<V>, ttlMs: number): boolean {
    return entry.updatedAt !== null && this.now() - entry.updatedAt < ttlMs;
  }

  /**
   * A rejected fetcher caches null rather than propagating. Nothing awaits this
   * promise, so a throw would surface as an unhandled rejection and take down a
   * host that installs a strict handler.
   */
  private async refresh<V, F>(
    entry: CacheEntry<V>,
    filter: F,
    fetcher: (filter: F) => Promise<V | null>,
  ): Promise<void> {
    try {
      entry.value = await fetcher(filter);
    } catch {
      entry.value = null;
    } finally {
      entry.updatedAt = this.now();
      entry.pending = null;
      this.notify(entry);
    }
  }

  private notify<V>(entry: CacheEntry<V>): void {
    const listeners = [...entry.listeners];
    entry.listeners.clear();

    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Repaint requests are best-effort: one listener throwing must not cost
        // the others their notification.
      }
    }
  }

  private evictOldestEntry(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}

export const asyncCache = new AsyncCache();
