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

  it('puts a visited typed URL ahead of later visits on that host', () => {
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

  it('stays closed until three characters, then matches a prefix', () => {
    expect(suggestBrowserAddresses('gi', history)).toEqual([]);
    expect(suggestBrowserAddresses('g', [])).toEqual([]);

    const fromPrefix = suggestBrowserAddresses('git', []);
    expect(fromPrefix.map((row) => row.url)).toEqual(
      expect.arrayContaining(['https://github.com/', 'https://gitee.com/'])
    );
    expect(fromPrefix[0]?.url).toBe('https://github.com/');

    const whileTyping = suggestBrowserAddresses('gith', []).map(
      (row) => row.url
    );
    expect(whileTyping).toContain('https://github.com/');
    expect(whileTyping).toContain('https://gitee.com/');
    expect(whileTyping[0]).toBe('https://github.com/');
    expect(suggestBrowserAddresses('hub', []).map((row) => row.url)).toContain(
      'https://github.com/'
    );
  });

  it('lists visited URLs before unvisited matches', () => {
    const rows = suggestBrowserAddresses('git', history);
    expect(rows.map((row) => row.url).slice(0, 3)).toEqual([
      'https://github.com/',
      'https://github.com/xintaofei/codeg',
      'https://github.com/Xircth/VibeX',
    ]);
    const gitee = rows.findIndex((row) => row.url === 'https://gitee.com/');
    expect(gitee).toBeGreaterThan(2);
    expect(rows.slice(0, gitee).every((row) => row.kind === 'history')).toBe(
      true
    );
    expect(rows[gitee]?.kind).toBe('completion');
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
