// Tiny, dependency-free LRU cache for cached completions.
// Keyed by SHA-1(model + messages + temperature + max_tokens).
// Stores the full upstream response body for non-stream requests.

export interface CacheEntry {
  key: string;
  body: string;
  contentType: string;
  status: number;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  inserts: number;
}

export class ResponseCache {
  private readonly map = new Map<string, CacheEntry>();
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, inserts: 0 };
  private enabled = true;
  private maxEntries = 1024;
  private ttlSeconds = 300;

  configure(opts: { enabled?: boolean; maxEntries?: number; ttlSeconds?: number }): void {
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
    if (opts.maxEntries !== undefined) {
      this.maxEntries = Math.max(0, opts.maxEntries);
      this.enforceCapacity();
    }
    if (opts.ttlSeconds !== undefined) this.ttlSeconds = Math.max(0, opts.ttlSeconds);
  }

  get(key: string): CacheEntry | undefined {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return undefined;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry;
  }

  set(key: string, body: string, contentType: string, status: number): void {
    if (!this.enabled || this.maxEntries === 0) return;
    if (this.map.has(key)) this.map.delete(key);
    const entry: CacheEntry = {
      key,
      body,
      contentType,
      status,
      createdAt: Date.now(),
      expiresAt: this.ttlSeconds > 0 ? Date.now() + this.ttlSeconds * 1000 : 0,
    };
    this.map.set(key, entry);
    this.stats.inserts++;
    this.enforceCapacity();
  }

  clear(): void {
    this.map.clear();
  }

  snapshot() {
    return {
      enabled: this.enabled,
      maxEntries: this.maxEntries,
      ttlSeconds: this.ttlSeconds,
      entries: this.map.size,
      stats: { ...this.stats },
    };
  }

  private enforceCapacity(): void {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (!oldest) break;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
  }
}
