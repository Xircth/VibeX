import { describe, expect, it } from 'vitest';

import {
  recordBrowserAddressVisit,
  suggestBrowserAddresses,
  type BrowserAddressHistoryEntry,
} from './addressSuggestions';

const history: BrowserAddressHistoryEntry[] = [
  {
    url: 'https://github.com/',
    title: 'GitHub',
    favicon: 'https://github.com/favicon.ico',
    visitedAt: 30,
  },
  {
    url: 'https://github.com/xintaofei/codeg',
    title: 'xintaofei/codeg: Collaborative multi-agent AI coding workspace',
    favicon: 'https://github.com/favicon.ico',
    visitedAt: 50,
  },
  {
    url: 'https://github.com/Xircth/VibeX',
    title: 'Xircth/VibeX: IADE',
    favicon: 'https://github.com/favicon.ico',
    visitedAt: 90,
  },
  {
    url: 'https://baidu.com/',
    title: '百度一下',
    favicon: 'https://baidu.com/favicon.ico',
    visitedAt: 10,
  },
];

describe('suggestBrowserAddresses', () => {
  it('returns no search-phrase rows', () => {
    expect(suggestBrowserAddresses('github 镜像站', history)).toEqual([]);
    expect(suggestBrowserAddresses('github releases', history)).toEqual([]);
    expect(suggestBrowserAddresses('   ', history)).toEqual([]);
  });

  it('puts the typed URL first and visited URLs last', () => {
    const rows = suggestBrowserAddresses('github.com', history);
    expect(rows[0]?.url).toBe('https://github.com/');
    expect(rows.slice(1).every((row) => row.kind === 'history')).toBe(true);
    expect(rows.map((row) => row.url)).toEqual([
      'https://github.com/',
      'https://github.com/xintaofei/codeg',
      'https://github.com/Xircth/VibeX',
    ]);
  });

  it('lists used URLs from oldest visit to newest', () => {
    const rows = suggestBrowserAddresses('github', history);
    expect(rows.every((row) => row.kind === 'history')).toBe(true);
    expect(rows.map((row) => row.url)).toEqual([
      'https://github.com/',
      'https://github.com/xintaofei/codeg',
      'https://github.com/Xircth/VibeX',
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'GitHub',
      'xintaofei/codeg: Collaborative multi-agent AI coding workspace',
      'Xircth/VibeX: IADE',
    ]);
  });

  it('keeps favicons on history rows', () => {
    const rows = suggestBrowserAddresses('baidu', history);
    expect(rows).toEqual([
      {
        kind: 'history',
        url: 'https://baidu.com/',
        title: '百度一下',
        favicon: 'https://baidu.com/favicon.ico',
      },
    ]);
  });
});

describe('recordBrowserAddressVisit', () => {
  it('moves a revisited URL to the end with a fresh title', () => {
    const next = recordBrowserAddressVisit(
      { url: 'https://github.com/', title: 'GitHub: Let’s build from here' },
      history,
      120
    );
    expect(next.at(-1)).toMatchObject({
      url: 'https://github.com/',
      title: 'GitHub: Let’s build from here',
      visitedAt: 120,
    });
  });
});
