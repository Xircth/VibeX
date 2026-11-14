/**
 * Character-budgeted LRU cache for prepared markdown blocks.
 *
 * Capacity is measured in source characters (not entries) so a handful of
 * huge code blocks cannot pin an unbounded amount of memory. Entries are
 * keyed by a content hash; the stored source is compared on every hit so a
 * hash collision degrades to a cache miss instead of rendering wrong content.
 *
 * The implementation intentionally uses the platform `Map` ordering (V8 keeps
 * insertion order and `delete`/`set` is enough to move an entry to the tail)
 * so no new dependency is required.
 */

/** Maximum characters kept per cache instance (~10MB of text). */
export const MAX_CACHED_CHARS = 500_000;

export type MarkdownBlockCacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  cachedChars: number;
};

type CacheEntry<T> = {
  value: T;
  source: string;
  charCount: number;
};

/**
 * cyrb53-style 53-bit string hash (inlined to avoid a dependency).
 * Returns a compact base36 string that includes the input length.
 */
export function hashMarkdownBlock(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}:${value.length.toString(36)}`;
}

export class MarkdownBlockCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private cachedChars = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxCachedChars: number = MAX_CACHED_CHARS) {}

  /**
   * Return a cached value when the stored source still matches `source`.
   * `source` is the exact text the value was produced from — a mismatch means
   * the key collided (or was rebuilt from different content), so it misses.
   */
  hit(key: string, source: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.source !== source) {
      this.misses += 1;
      return undefined;
    }

    // Move to the tail so `Map` insertion order acts as recency order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** Store a value; existing keys are replaced and refreshed. */
  set(key: string, source: string, value: T): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.cachedChars -= existing.charCount;
      this.entries.delete(key);
    }

    const charCount = source.length;
    this.entries.set(key, { value, source, charCount });
    this.cachedChars += charCount;
    this.evict();
  }

  clear(): void {
    this.entries.clear();
    this.cachedChars = 0;
  }

  stats(): MarkdownBlockCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries: this.entries.size,
      cachedChars: this.cachedChars,
    };
  }

  /** Reset hit/miss counters (capacity and entries stay intact). */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalChars(): number {
    return this.cachedChars;
  }

  /** Evict least-recently-used entries until the budget is respected. */
  private evict(): void {
    if (this.cachedChars <= this.maxCachedChars) return;

    for (const [key, entry] of this.entries) {
      if (this.cachedChars <= this.maxCachedChars) break;
      this.entries.delete(key);
      this.cachedChars -= entry.charCount;
      this.evictions += 1;
    }
  }
}
