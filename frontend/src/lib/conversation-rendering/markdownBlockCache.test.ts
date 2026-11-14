import { describe, expect, it } from 'vitest';
import {
  hashMarkdownBlock,
  MarkdownBlockCache,
  MAX_CACHED_CHARS,
} from './markdownBlockCache';
import { preprocessForBlockSplit, splitIntoBlocks } from './markdownPreprocess';
import {
  prepareConversationMarkdownCached,
  prepareSingleMarkdownBlock,
  type ConversationMarkdownPrepareCache,
} from './streamdownPlugins';

function buildSyntheticDocument(targetChars: number): string {
  const blocks: string[] = [];
  let total = 0;
  let index = 0;

  while (total < targetChars) {
    const kind = index % 5;
    let block = '';
    if (kind === 0) {
      block = `## Section ${index}: Architecture & Streaming Pipeline\nDetailed analysis for section ${index} covering incremental block boundaries, stable hashes, and zero-flicker reconciliation across frames.`;
    } else if (kind === 1) {
      block = [
        '```ts',
        `export function computeMetrics_${index}(input: ReadonlyArray<number>): number {`,
        `  let acc = ${index};`,
        '  for (const item of input) {',
        '    acc = (acc * 31 + item) >>> 0;',
        '  }',
        '  return acc;',
        '}',
        '```',
      ].join('\n');
    } else if (kind === 2) {
      block = [
        '| Metric | Baseline | Optimized |',
        '| --- | --- | --- |',
        `| Step ${index} | 38.4ms | 1.2ms |`,
        `| HitRate ${index} | 0% | 98.5% |`,
      ].join('\n');
    } else if (kind === 3) {
      block = [
        '\\[',
        `E_{${index}} = \\sum_{k=1}^{n} \\frac{\\alpha_k + ${index}}{k^2}`,
        '',
        `\\Delta_{${index}} = E_{${index}} - E_{${Math.max(0, index - 1)}}`,
        '\\]',
      ].join('\n');
    } else {
      block = `- Item ${index}.1: Preserve virtualized \`process-fold\` slices for large tool runs.\n- Item ${index}.2: Keep \`requestAnimationFrame\` adaptive coalescing at \`STREAM_FLUSH_MAX_MS = 96\`.`;
    }

    blocks.push(block);
    total += block.length + 2;
    index += 1;
  }

  return blocks.join('\n\n');
}

function percentile99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.99)
  );
  return sorted[idx] ?? 0;
}

describe('MarkdownBlockCache & streaming performance', () => {
  it('enforces MAX_CACHED_CHARS = 500_000 budget and evicts least-recently-used entries', () => {
    expect(MAX_CACHED_CHARS).toBe(500_000);
    const cache = new MarkdownBlockCache<string>(MAX_CACHED_CHARS);

    const chunkSize = 100_000;
    const sources = Array.from({ length: 6 }, (_, i) =>
      `block-${i}-${'x'.repeat(chunkSize - 8)}`
    );

    for (let i = 0; i < 5; i += 1) {
      const src = sources[i]!;
      cache.set(hashMarkdownBlock(src), src, `compiled-${i}`);
    }
    expect(cache.totalChars).toBe(500_000);
    expect(cache.size).toBe(5);

    // Touch entry 0 so entry 1 becomes the oldest LRU entry.
    expect(cache.hit(hashMarkdownBlock(sources[0]!), sources[0]!)).toBe(
      'compiled-0'
    );

    // Inserting entry 5 (100k chars) must evict entry 1, keeping entry 0 alive.
    const sixth = sources[5]!;
    cache.set(hashMarkdownBlock(sixth), sixth, 'compiled-5');

    expect(cache.totalChars).toBeLessThanOrEqual(MAX_CACHED_CHARS);
    expect(cache.hit(hashMarkdownBlock(sources[1]!), sources[1]!)).toBeUndefined();
    expect(cache.hit(hashMarkdownBlock(sources[0]!), sources[0]!)).toBe(
      'compiled-0'
    );
    expect(cache.stats().evictions).toBeGreaterThanOrEqual(1);
  });

  it('guards against hash collisions by verifying the stored source string', () => {
    const cache = new MarkdownBlockCache<string>(10_000);
    cache.set('forced-same-key', 'original paragraph', 'compiled-original');

    expect(cache.hit('forced-same-key', 'different paragraph')).toBeUndefined();
    expect(cache.hit('forced-same-key', 'original paragraph')).toBe(
      'compiled-original'
    );
  });

  it('achieves > 90% LRU hit rate and P99 < 8ms per incremental step on 10k-char streaming', () => {
    const fullDoc = buildSyntheticDocument(10_500);
    expect(fullDoc.length).toBeGreaterThanOrEqual(10_000);

    const blockCache = new MarkdownBlockCache<string>(MAX_CACHED_CHARS);
    const stepSize = 128;
    const frameTimesMs: number[] = [];

    // Warm up JIT once
    const warm = preprocessForBlockSplit(fullDoc.slice(0, 512));
    splitIntoBlocks(warm.body, warm.mathSpans, true);

    for (let cursor = stepSize; cursor <= fullDoc.length; cursor += stepSize) {
      const slice = fullDoc.slice(0, cursor);
      const t0 = performance.now();
      const { body, mathSpans } = preprocessForBlockSplit(slice);
      const blocks = splitIntoBlocks(body, mathSpans, true);
      for (const block of blocks) {
        if (block.closed) {
          const hit = blockCache.hit(block.hash, block.text);
          if (!hit) {
            blockCache.set(
              block.hash,
              block.text,
              prepareSingleMarkdownBlock(block.text)
            );
          }
        } else {
          prepareSingleMarkdownBlock(block.text);
        }
      }
      frameTimesMs.push(performance.now() - t0);
    }

    const stats = blockCache.stats();
    const hitRate = stats.hits / (stats.hits + stats.misses);
    const p99 = percentile99(frameTimesMs);

    expect(hitRate).toBeGreaterThan(0.9);
    expect(p99).toBeLessThan(8);
    expect(stats.cachedChars).toBeLessThanOrEqual(MAX_CACHED_CHARS);
  });

  it('handles 50k-char streaming smoothly with > 95% cache hit rate and bounded memory', () => {
    const fullDoc = buildSyntheticDocument(50_500);
    expect(fullDoc.length).toBeGreaterThanOrEqual(50_000);

    // Warm up JIT before timing
    prepareConversationMarkdownCached(fullDoc.slice(0, 1024));

    let prepCache: ConversationMarkdownPrepareCache | null = null;
    const stepSize = 512;
    const frameTimesMs: number[] = [];

    for (let cursor = stepSize; cursor <= fullDoc.length; cursor += stepSize) {
      const slice = fullDoc.slice(0, cursor);
      const t0 = performance.now();
      const next = prepareConversationMarkdownCached(slice, {}, prepCache);
      frameTimesMs.push(performance.now() - t0);
      prepCache = next.cache;
    }

    expect(prepCache).not.toBeNull();
    const stats = prepCache!.lru.stats();
    const hitRate = stats.hits / (stats.hits + stats.misses);
    const sorted = [...frameTimesMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p99 = percentile99(frameTimesMs);

    expect(hitRate).toBeGreaterThan(0.95);
    expect(stats.cachedChars).toBeLessThanOrEqual(MAX_CACHED_CHARS);
    expect(median).toBeLessThan(5);
    expect(p99).toBeLessThan(25);
  });
});
