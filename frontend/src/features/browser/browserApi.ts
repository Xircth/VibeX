import { backendListen } from '@/lib/backendTransport';
import { desktopShellCall } from '@/lib/desktopShell';
import type {
  BrowserEvent,
  BrowserIntent,
  BrowserTab,
  BrowserTabId,
  CreateBrowserTab,
} from './browserTypes';

export const browserApi = {
  createTab(request: CreateBrowserTab): Promise<BrowserTab> {
    return desktopShellCall<BrowserTab>('browser_create_tab', { request });
  },

  applyIntent(tabId: BrowserTabId, intent: BrowserIntent): Promise<void> {
    return desktopShellCall<void>('browser_apply_intent', { tabId, intent });
  },

  closeTab(tabId: BrowserTabId): Promise<void> {
    return desktopShellCall<void>('browser_close_tab', { tabId });
  },

  getTab(tabId: BrowserTabId): Promise<BrowserTab | null> {
    return desktopShellCall<BrowserTab | null>('browser_get_tab', { tabId });
  },

  listen(listener: (event: BrowserEvent) => void) {
    return backendListen<BrowserEvent>('browser://event', listener);
  },
};
