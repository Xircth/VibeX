import { completeBrowserAddress } from './completeAddress';

export const ADDRESS_HISTORY_KEY = 'vibex.host-browser.address-history';
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

/** Popup starts at 3 characters so a short accidental keypress stays quiet. */
export const ADDRESS_QUERY_MIN_LENGTH = 3;

/**
 * Sites the bar can offer before they have been visited. Order is popularity
 * within the same match quality: `git` / `gith` must surface GitHub and Gitee
 * without waiting for the rest of the name.
 */
const KNOWN_SITES: readonly { host: string; title: string }[] = [
  { host: 'github.com', title: 'GitHub' },
  { host: 'gitee.com', title: 'Gitee' },
  { host: 'gitlab.com', title: 'GitLab' },
  { host: 'gitbook.com', title: 'GitBook' },
  { host: 'google.com', title: 'Google' },
  { host: 'bing.com', title: 'Bing' },
  { host: 'baidu.com', title: '百度' },
  { host: 'bilibili.com', title: '哔哩哔哩' },
  { host: 'youtube.com', title: 'YouTube' },
  { host: 'wikipedia.org', title: 'Wikipedia' },
  { host: 'stackoverflow.com', title: 'Stack Overflow' },
  { host: 'npmjs.com', title: 'npm' },
  { host: 'developer.mozilla.org', title: 'MDN' },
  { host: 'microsoft.com', title: 'Microsoft' },
  { host: 'apple.com', title: 'Apple' },
  { host: 'amazon.com', title: 'Amazon' },
  { host: 'reddit.com', title: 'Reddit' },
  { host: 'zhihu.com', title: '知乎' },
  { host: 'weibo.com', title: '微博' },
  { host: 'taobao.com', title: '淘宝' },
  { host: 'jd.com', title: '京东' },
  { host: 'qq.com', title: 'QQ' },
  { host: 'douyin.com', title: '抖音' },
  { host: 'tiktok.com', title: 'TikTok' },
  { host: 'openai.com', title: 'OpenAI' },
  { host: 'x.com', title: 'X' },
  { host: 'twitter.com', title: 'Twitter' },
  { host: 'linkedin.com', title: 'LinkedIn' },
  { host: 'notion.so', title: 'Notion' },
  { host: 'figma.com', title: 'Figma' },
  { host: 'vercel.com', title: 'Vercel' },
  { host: 'csdn.net', title: 'CSDN' },
  { host: 'juejin.cn', title: '掘金' },
  { host: 'v2ex.com', title: 'V2EX' },
];

const SECOND_LEVEL_SUFFIXES = new Set([
  'com',
  'co',
  'org',
  'net',
  'gov',
  'edu',
  'ac',
]);

function meaningfulQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
}

function hostPart(needle: string): string {
  return needle.split(/[/?#]/, 1)[0] ?? needle;
}

function significantLabels(host: string): string[] {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length >= 3 && SECOND_LEVEL_SUFFIXES.has(parts.at(-2) ?? '')) {
    return parts.slice(0, -2);
  }
  if (parts.length >= 2) return parts.slice(0, -1);
  return parts;
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function levenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid: number[] = new Array(rows * cols);
  for (let row = 0; row < rows; row += 1) grid[row * cols] = row;
  for (let col = 0; col < cols; col += 1) grid[col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      grid[row * cols + col] = Math.min(
        grid[(row - 1) * cols + col] + 1,
        grid[row * cols + col - 1] + 1,
        grid[(row - 1) * cols + col - 1] + cost
      );
    }
  }
  return grid[rows * cols - 1] ?? 0;
}

/**
 * 0 prefix, 1 substring, 2 near-stem (`gith` → `gitee`). `null` is no match.
 * Fuzzy stays tight once the query is longer than four characters, so
 * `github` does not also pull in every other `git*` site.
 */
function fuzzyRank(needle: string, label: string): number | null {
  if (needle.length < ADDRESS_QUERY_MIN_LENGTH || label.length < 3) return null;
  if (sharedPrefixLength(needle, label) < ADDRESS_QUERY_MIN_LENGTH) return null;
  if (Math.abs(needle.length - label.length) > 3) return null;
  const maxDistance = needle.length <= 4 ? 2 : 1;
  return levenshtein(needle, label) <= maxDistance ? 2 : null;
}

function rankHost(hostNeedle: string, host: string): number | null {
  const normalized = host.toLowerCase();
  if (
    normalized.startsWith(hostNeedle) ||
    hostNeedle.startsWith(`${normalized}/`) ||
    hostNeedle === normalized
  ) {
    return 0;
  }
  let best: number | null = null;
  const consider = (rank: number | null) => {
    if (rank == null) return;
    if (best == null || rank < best) best = rank;
  };
  for (const label of significantLabels(normalized)) {
    if (
      label.startsWith(hostNeedle) ||
      hostNeedle === label ||
      hostNeedle.startsWith(`${label}.`)
    ) {
      consider(0);
      continue;
    }
    if (label.includes(hostNeedle)) consider(1);
    consider(fuzzyRank(hostNeedle, label));
  }
  return best;
}

function historyMatches(
  entry: BrowserAddressHistoryEntry,
  needle: string
): boolean {
  if (entry.title.toLowerCase().includes(needle)) return true;
  const host = hostnameOf(entry.url).toLowerCase();
  if (rankHost(hostPart(needle), host) != null) return true;
  try {
    const parsed = new URL(entry.url);
    const path =
      `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    return path.length > 1 && path.includes(needle);
  } catch {
    return false;
  }
}

function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function catalogUrl(host: string): string | null {
  return completeBrowserAddress(host);
}

/**
 * Address-bar completions only. Phrases with spaces produce nothing.
 * Visited URLs come first. Known sites still match by prefix, substring, or
 * a short stem (`git` / `gith` → github.com, gitee.com) before the full name
 * is typed. The list stays closed until three characters are entered.
 */
export function suggestBrowserAddresses(
  raw: string,
  history: readonly BrowserAddressHistoryEntry[]
): BrowserAddressSuggestion[] {
  const query = raw.trim();
  if (!query || /\s/.test(query)) return [];
  const needle = meaningfulQuery(query);
  if (needle.length < ADDRESS_QUERY_MIN_LENGTH) return [];

  const visited = history
    .filter((entry) => historyMatches(entry, needle))
    .sort((left, right) => left.visitedAt - right.visitedAt);

  const suggestions: BrowserAddressSuggestion[] = visited.map((entry) => ({
    kind: 'history',
    url: entry.url,
    title: entry.title,
    favicon: entry.favicon,
  }));
  const seen = new Set(suggestions.map((item) => canonicalUrl(item.url)));

  const catalog = KNOWN_SITES.map((site, index) => ({
    site,
    index,
    rank: rankHost(hostPart(needle), site.host),
    titleRank: site.title.toLowerCase().includes(hostPart(needle)) ? 1 : null,
  }))
    .map((item) => ({
      ...item,
      rank:
        item.rank == null
          ? item.titleRank
          : item.titleRank == null
            ? item.rank
            : Math.min(item.rank, item.titleRank),
    }))
    .filter((item): item is typeof item & { rank: number } => item.rank != null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);

  for (const item of catalog) {
    const url = catalogUrl(item.site.host);
    if (!url || seen.has(canonicalUrl(url))) continue;
    suggestions.push({
      kind: 'completion',
      url,
      title: item.site.title,
      favicon: faviconForAddress(url),
    });
    seen.add(canonicalUrl(url));
  }

  const completed = completeBrowserAddress(query);
  if (completed && !seen.has(canonicalUrl(completed))) {
    const known = KNOWN_SITES.find(
      (site) => catalogUrl(site.host) === completed
    );
    suggestions.push({
      kind: 'completion',
      url: completed,
      title: known?.title ?? hostnameOf(completed),
      favicon: faviconForAddress(completed),
    });
  }

  return suggestions.slice(0, ADDRESS_SUGGESTION_LIMIT);
}
