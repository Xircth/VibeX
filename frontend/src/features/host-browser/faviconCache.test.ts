import { describe, expect, it } from 'vitest';

import {
  FAVICON_CACHE_KEY,
  faviconForPage,
  lookupCachedFavicon,
  originFavicon,
  rememberCachedFavicon,
} from './faviconCache';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = { ...initial };
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
    getItem(key: string) {
      return data[key] ?? null;
    },
    key(index: number) {
      return Object.keys(data)[index] ?? null;
    },
    removeItem(key: string) {
      delete data[key];
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}

describe('favicon cache', () => {
  it('falls back to origin/favicon.ico on a first visit', () => {
    expect(originFavicon('https://github.com/xintaofei/codeg')).toBe(
      'https://github.com/favicon.ico'
    );
    expect(faviconForPage('https://github.com/xintaofei/codeg')).toBe(
      'https://github.com/favicon.ico'
    );
  });

  it('reuses a discovered icon for the same origin immediately', () => {
    const storage = memoryStorage();
    rememberCachedFavicon(
      'https://github.com/',
      'https://github.githubassets.com/favicons/favicon.svg',
      storage
    );
    expect(lookupCachedFavicon('https://github.com/xintaofei/codeg', storage)).toBe(
      'https://github.githubassets.com/favicons/favicon.svg'
    );
    expect(JSON.parse(storage.getItem(FAVICON_CACHE_KEY) ?? '{}')).toEqual({
      'https://github.com':
        'https://github.githubassets.com/favicons/favicon.svg',
    });
  });
});
