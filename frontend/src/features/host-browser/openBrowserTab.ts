import { backendListen } from '@/lib/backendTransport';

export type BrowserTabOpenRequest = {
  url?: string | null;
  nativeTabId?: string | null;
  tabId?: string | null;
  sourceTabId?: string | null;
};

type BrowserTabOpenHandler = (request: BrowserTabOpenRequest) => void;

const pending: BrowserTabOpenRequest[] = [];
const recent = new Map<string, number>();
let handler: BrowserTabOpenHandler | null = null;

function requestKey(request: BrowserTabOpenRequest): string {
  // Same click can emit a JS `tab.open` (no native id) and an adopted
  // engine view (`nativeTabId`). Collapse those to one panel.
  return `${request.url ?? ''}|${request.sourceTabId ?? ''}`;
}

function isDuplicate(
  request: BrowserTabOpenRequest,
  now = Date.now()
): boolean {
  const key = requestKey(request);
  const last = recent.get(key);
  if (last != null && now - last < 750) return true;
  recent.set(key, now);
  if (recent.size > 16) {
    for (const [item, at] of recent) {
      if (now - at > 2000) recent.delete(item);
    }
  }
  return false;
}

export function setBrowserTabOpenHandler(
  next: BrowserTabOpenHandler | null
): void {
  handler = next;
  if (!handler) {
    recent.clear();
    return;
  }
  const queued = pending.splice(0, pending.length);
  for (const request of queued) handler(request);
}

export function requestBrowserTabOpen(request: BrowserTabOpenRequest): boolean {
  if (!request.url && !request.nativeTabId) return false;
  if (isDuplicate(request)) return true;
  try {
    console.info('[vibex-browser] open tab', request);
  } catch {
    /* ignore */
  }
  if (handler) {
    handler(request);
    return true;
  }
  pending.push(request);
  return false;
}

let pageEventListening = false;

function onBrowserTabOpenEvent(event: Event): void {
  const detail = (event as CustomEvent<BrowserTabOpenRequest | null>).detail;
  if (!detail) return;
  requestBrowserTabOpen({
    url: detail.url,
    nativeTabId: detail.nativeTabId ?? detail.tabId,
    sourceTabId: detail.sourceTabId,
  });
}

/** Subscribe once, outside React effects, so a tab.open cannot miss the UI. */
export function ensureBrowserTabOpenBridge(): void {
  if (pageEventListening) return;
  pageEventListening = true;
  void backendListen<{
    kind?: string;
    url?: string;
    tabId?: string;
    nativeTabId?: string;
    sourceTabId?: string;
  }>('plugin.browser', (payload) => {
    if (payload?.kind !== 'tab.open') return;
    requestBrowserTabOpen({
      url: payload.url,
      nativeTabId: payload.nativeTabId ?? payload.tabId,
      sourceTabId: payload.sourceTabId,
    });
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('vibex-browser-tab-open', onBrowserTabOpenEvent);
}
