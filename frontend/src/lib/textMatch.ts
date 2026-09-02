const TIER_BASE = 100_000_000;
const TIER_EXACT = 6;
const TIER_PREFIX = 5;
const TIER_SUBSTRING = 4;
const TIER_SUBSEQUENCE = 3;

function tierScore(tier: number, position: number, length: number): number {
  return (
    tier * TIER_BASE - Math.min(position, 9_999) * 1_000 - Math.min(length, 999)
  );
}

export function subsequenceFirstIndex(query: string, text: string): number {
  let queryIndex = 0;
  let firstIdx = -1;
  for (
    let textIndex = 0;
    textIndex < text.length && queryIndex < query.length;
    textIndex += 1
  ) {
    if (text[textIndex] === query[queryIndex]) {
      if (queryIndex === 0) firstIdx = textIndex;
      queryIndex += 1;
    }
  }
  return queryIndex === query.length ? firstIdx : -1;
}

export function scoreTextMatch(query: string, text: string): number | null {
  if (!query) return null;
  if (text === query) return tierScore(TIER_EXACT, 0, text.length);
  if (text.startsWith(query)) return tierScore(TIER_PREFIX, 0, text.length);
  const idx = text.indexOf(query);
  if (idx !== -1) return tierScore(TIER_SUBSTRING, idx, text.length);
  const sub = subsequenceFirstIndex(query, text);
  if (sub !== -1) return tierScore(TIER_SUBSEQUENCE, sub, text.length);
  return null;
}

export function normalizeInvocationQuery(query: string): string {
  return query
    .trim()
    .replace(/^[/$]+/, '')
    .toLowerCase();
}

export function rankByTextMatch<T>(
  query: string,
  items: readonly T[],
  getPrimary: (item: T) => string,
  getSecondary?: (item: T) => string | undefined | null
): T[] {
  const q = normalizeInvocationQuery(query);
  if (!q) return items.slice();

  const secondaryOffset = TIER_EXACT * TIER_BASE;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const primary = getPrimary(item).toLowerCase();
    let score = scoreTextMatch(q, primary);
    if (score === null && getSecondary) {
      const secondary = getSecondary(item)?.toLowerCase();
      if (secondary) {
        const secondaryScore = scoreTextMatch(q, secondary);
        if (secondaryScore !== null) score = secondaryScore - secondaryOffset;
      }
    }
    if (score !== null) scored.push({ item, score });
  }

  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry) => entry.item);
}
