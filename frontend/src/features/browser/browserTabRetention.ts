import type { BrowserTab, BrowserTabId } from './browserTypes';

/**
 * Dockview `fromJSON` remounts every panel when the workspace zone
 * arrangement changes. The native Chromium tab is independent of that React
 * host, so a brief retain window lets the new host reclaim the same page
 * instead of destroying it and leaving a blank preview.
 */
export const BROWSER_TAB_RETAIN_MS = 1500;

type CloseTab = (tabId: BrowserTabId) => void;

interface RetainedBrowserTab {
  tab: BrowserTab;
  close: CloseTab;
  timeoutId: ReturnType<typeof setTimeout>;
}

const retainedTabs = new Map<string, RetainedBrowserTab>();

export function retainBrowserTab(
  key: string,
  tab: BrowserTab,
  close: CloseTab,
  retainMs: number = BROWSER_TAB_RETAIN_MS
): void {
  const existing = retainedTabs.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    if (existing.tab.id !== tab.id) {
      existing.close(existing.tab.id);
    }
  }

  const timeoutId = setTimeout(() => {
    retainedTabs.delete(key);
    close(tab.id);
  }, retainMs);

  retainedTabs.set(key, { tab, close, timeoutId });
}

export function reclaimBrowserTab(key: string): BrowserTab | null {
  const existing = retainedTabs.get(key);
  if (!existing) return null;
  clearTimeout(existing.timeoutId);
  retainedTabs.delete(key);
  return existing.tab;
}

export function discardRetainedBrowserTabs(): void {
  for (const [key, existing] of retainedTabs) {
    clearTimeout(existing.timeoutId);
    retainedTabs.delete(key);
    existing.close(existing.tab.id);
  }
}
