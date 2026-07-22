import { tauriInvoke, tauriListen } from '@/lib/tauriApi';
import type {
  BrowserEvent,
  BrowserIntent,
  BrowserTab,
  BrowserTabId,
  CreateBrowserTab,
} from './browserTypes';

export const browserApi = {
  createTab(request: CreateBrowserTab): Promise<BrowserTab> {
    return tauriInvoke<BrowserTab>('browser_create_tab', { request });
  },

  applyIntent(tabId: BrowserTabId, intent: BrowserIntent): Promise<void> {
    return tauriInvoke<void>('browser_apply_intent', { tabId, intent });
  },

  closeTab(tabId: BrowserTabId): Promise<void> {
    return tauriInvoke<void>('browser_close_tab', { tabId });
  },

  getTab(tabId: BrowserTabId): Promise<BrowserTab | null> {
    return tauriInvoke<BrowserTab | null>('browser_get_tab', { tabId });
  },

  listen(listener: (event: BrowserEvent) => void) {
    return tauriListen<BrowserEvent>('browser://event', listener);
  },
};
