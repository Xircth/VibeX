import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(async () => () => {}),
  backendCall: vi.fn(),
}));

import {
  requestBrowserTabOpen,
  setBrowserTabOpenHandler,
} from './openBrowserTab';

describe('requestBrowserTabOpen', () => {
  it('queues until a handler is registered, then dedupes bursts', () => {
    setBrowserTabOpenHandler(null);
    const seen: string[] = [];
    expect(
      requestBrowserTabOpen({ url: 'https://github.com/xintaofei/codeg' })
    ).toBe(false);
    setBrowserTabOpenHandler((request) => {
      seen.push(request.url ?? '');
    });
    expect(seen).toEqual(['https://github.com/xintaofei/codeg']);
    expect(
      requestBrowserTabOpen({ url: 'https://github.com/xintaofei/codeg' })
    ).toBe(true);
    expect(seen).toEqual(['https://github.com/xintaofei/codeg']);
    expect(
      requestBrowserTabOpen({
        url: 'https://example.com/a',
        sourceTabId: 'tab-1',
        nativeTabId: 'tab-1-p1',
      })
    ).toBe(true);
    expect(
      requestBrowserTabOpen({
        url: 'https://example.com/a',
        sourceTabId: 'tab-1',
      })
    ).toBe(true);
    expect(seen).toEqual([
      'https://github.com/xintaofei/codeg',
      'https://example.com/a',
    ]);
    setBrowserTabOpenHandler(null);
  });
});
