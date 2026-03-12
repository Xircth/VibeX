import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";

const SEARCH_RECENCY_KEY = "search.recentOpenMap";
const MAX_RECENCY_ENTRIES = 400;

type RecencyMap = Record<string, number>;

export function loadSearchRecencyMap(): RecencyMap {
  const stored = getClientStoreSync<unknown>("app", SEARCH_RECENCY_KEY);
  if (!stored || typeof stored !== "object") {
    return {};
  }
  const next: RecencyMap = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      next[key] = value;
    }
  }
  return next;
}

export function recordSearchResultOpen(resultId: string): void {
  if (!resultId) {
    return;
  }
  const current = loadSearchRecencyMap();
  current[resultId] = Date.now();
  const entries = Object.entries(current)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENCY_ENTRIES);
  writeClientStoreValue("app", SEARCH_RECENCY_KEY, Object.fromEntries(entries));
}
