import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from './browserTypes';
import {
  BROWSER_TAB_RETAIN_MS,
  discardRetainedBrowserTabs,
  reclaimBrowserTab,
  retainBrowserTab,
} from './browserTabRetention';

function tab(id: string): BrowserTab {
  return {
    id,
    url: 'https://www.baidu.com/',
    title: '百度一下',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomLevel: 0,
    profile: { kind: 'global' },
    surface: {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      scaleFactor: 1,
      visible: true,
    },
  };
}

describe('browserTabRetention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    discardRetainedBrowserTabs();
    vi.useRealTimers();
  });

  it('reclaims a tab across a brief host remount without closing it', () => {
    const close = vi.fn();
    retainBrowserTab('preview-1', tab('browser-tab-1'), close);

    expect(reclaimBrowserTab('preview-1')).toEqual(tab('browser-tab-1'));
    expect(close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BROWSER_TAB_RETAIN_MS);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the native tab when no host reclaims it', () => {
    const close = vi.fn();
    retainBrowserTab('preview-1', tab('browser-tab-1'), close);

    vi.advanceTimersByTime(BROWSER_TAB_RETAIN_MS - 1);
    expect(close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledWith('browser-tab-1');
    expect(reclaimBrowserTab('preview-1')).toBeNull();
  });
});
