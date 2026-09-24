import { completeBrowserAddress } from './completeAddress';

export const ADDRESS_HISTORY_KEY = 'vibex.browser.address-history';
export const ADDRESS_HISTORY_LIMIT = 80;
export const ADDRESS_SUGGESTION_LIMIT = 8;

export type BrowserAddressHistoryEntry = {
  url: string;
  title: string;
  favicon: string | null;
  visitedAt: number;
};

export type BrowserAddressSuggestion = {
  kind: 'completion' | 'history';
  url: string;
  title: string;
  favicon: string | null;
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function faviconForAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function normalizeHistory(value: unknown): BrowserAddressHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: BrowserAddressHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<BrowserAddressHistoryEntry>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title:
        typeof record.title === 'string' && record.title.trim()
          ? record.title.trim()
          : hostnameOf(url),
      favicon:
        typeof record.favicon === 'string' && record.favicon
          ? record.favicon
          : faviconForAddress(url),
      visitedAt:
        typeof record.visitedAt === 'number' &&
        Number.isFinite(record.visitedAt)
          ? record.visitedAt
          : 0,
    });
  }
  return out.slice(0, ADDRESS_HISTORY_LIMIT);
}

export function loadBrowserAddressHistory(
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage
): BrowserAddressHistoryEntry[] {
  if (!storage) return [];
  try {
    return normalizeHistory(
      JSON.parse(storage.getItem(ADDRESS_HISTORY_KEY) ?? '[]')
    );
  } catch {
    return [];
  }
}

export function saveBrowserAddressHistory(
  history: BrowserAddressHistoryEntry[],
  storage: Pick<Storage, 'setItem'> | null | undefined = globalThis.localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(
      ADDRESS_HISTORY_KEY,
      JSON.stringify(history.slice(0, ADDRESS_HISTORY_LIMIT))
    );
  } catch {
    /* quota / private mode */
  }
}

export function recordBrowserAddressVisit(
  visit: {
    url: string;
    title?: string | null;
    favicon?: string | null;
  },
  history: BrowserAddressHistoryEntry[],
  now = Date.now()
): BrowserAddressHistoryEntry[] {
  const url = completeBrowserAddress(visit.url);
  if (!url) return history;
  const title = visit.title?.trim() || hostnameOf(url);
  const favicon = visit.favicon || faviconForAddress(url);
  const next = history.filter((entry) => entry.url !== url);
  next.push({ url, title, favicon, visitedAt: now });
  return next.slice(-ADDRESS_HISTORY_LIMIT);
}

function matchesQuery(
  entry: BrowserAddressHistoryEntry,
  query: string
): boolean {
  const q = query.toLowerCase();
  return (
    entry.url.toLowerCase().includes(q) ||
    entry.title.toLowerCase().includes(q) ||
    hostnameOf(entry.url).toLowerCase().includes(q)
  );
}

/**
 * Address-bar completions only. Search phrases (spaces, no host) produce
 * nothing. Typed URL completions come first; visited URLs are listed last.
 */
export function suggestBrowserAddresses(
  raw: string,
  history: readonly BrowserAddressHistoryEntry[]
): BrowserAddressSuggestion[] {
  const query = raw.trim();
  if (!query || /\s/.test(query)) return [];

  const completed = completeBrowserAddress(query);
  const matches = history
    .filter((entry) => matchesQuery(entry, query))
    .sort((left, right) => left.visitedAt - right.visitedAt);

  const suggestions: BrowserAddressSuggestion[] = [];
  if (completed) {
    const exact = matches.find((entry) => entry.url === completed);
    suggestions.push(
      exact
        ? {
            kind: 'history',
            url: exact.url,
            title: exact.title,
            favicon: exact.favicon,
          }
        : {
            kind: 'completion',
            url: completed,
            title: hostnameOf(completed),
            favicon: faviconForAddress(completed),
          }
    );
  }

  for (const entry of matches) {
    if (entry.url === completed) continue;
    suggestions.push({
      kind: 'history',
      url: entry.url,
      title: entry.title,
      favicon: entry.favicon,
    });
  }

  return suggestions.slice(0, ADDRESS_SUGGESTION_LIMIT);
}
