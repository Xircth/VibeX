import type { SearchResult } from "../types";

const RECENT_OPEN_BOOST_MS = 1000 * 60 * 60 * 24 * 7;

type RecencyMap = Record<string, number>;

function computeRecencyBonus(resultId: string, recencyMap: RecencyMap): number {
  const openedAt = recencyMap[resultId];
  if (!openedAt) {
    return 0;
  }
  const elapsed = Date.now() - openedAt;
  if (elapsed <= 0) {
    return 20;
  }
  if (elapsed >= RECENT_OPEN_BOOST_MS) {
    return 0;
  }
  const ratio = 1 - elapsed / RECENT_OPEN_BOOST_MS;
  return Math.round(ratio * 20);
}

export function compareSearchResults(
  a: SearchResult,
  b: SearchResult,
  recencyMap: RecencyMap,
): number {
  const scoreA = a.score - computeRecencyBonus(a.id, recencyMap);
  const scoreB = b.score - computeRecencyBonus(b.id, recencyMap);

  if (scoreA !== scoreB) {
    return scoreA - scoreB;
  }

  const updatedAtA = a.updatedAt ?? 0;
  const updatedAtB = b.updatedAt ?? 0;
  if (updatedAtA !== updatedAtB) {
    return updatedAtB - updatedAtA;
  }

  return a.title.localeCompare(b.title);
}
