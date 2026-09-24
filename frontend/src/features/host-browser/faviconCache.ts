export const FAVICON_CACHE_KEY = 'vibex.browser.favicon-cache';
export const FAVICON_CACHE_LIMIT = 200;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function originFavicon(url: string): string | null {
  const origin = originOf(url);
  return origin ? `${origin}/favicon.ico` : null;
}

function readCache(
  storage: Pick<Storage, 'getItem'> | null | undefined
): Record<string, string> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(
      storage.getItem(FAVICON_CACHE_KEY) ?? '{}'
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [origin, href] of Object.entries(parsed)) {
      if (typeof href === 'string' && href) out[origin] = href;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(
  cache: Record<string, string>,
  storage: Pick<Storage, 'setItem'> | null | undefined
): void {
  if (!storage) return;
  const entries = Object.entries(cache);
  const trimmed =
    entries.length > FAVICON_CACHE_LIMIT
      ? Object.fromEntries(entries.slice(entries.length - FAVICON_CACHE_LIMIT))
      : cache;
  try {
    storage.setItem(FAVICON_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota / private mode */
  }
}

export function lookupCachedFavicon(
  url: string,
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage
): string | null {
  const origin = originOf(url);
  if (!origin) return null;
  return readCache(storage)[origin] ?? null;
}

export function rememberCachedFavicon(
  url: string,
  favicon: string,
  storage:
    | Pick<Storage, 'getItem' | 'setItem'>
    | null
    | undefined = globalThis.localStorage
): void {
  const origin = originOf(url);
  const href = favicon.trim();
  if (!origin || !href) return;
  const cache = readCache(storage);
  cache[origin] = href;
  writeCache(cache, storage);
}

export function faviconForPage(url: string): string | null {
  return lookupCachedFavicon(url) ?? originFavicon(url);
}

export function prefetchFavicon(url: string | null | undefined): void {
  if (!url || typeof Image === 'undefined') return;
  const image = new Image();
  image.referrerPolicy = 'no-referrer';
  image.src = url;
}
