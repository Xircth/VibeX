export type AgentActivityEntry = {
  action: string;
  outcome: 'done' | 'refused' | 'failed' | string;
  at: number;
  count: number;
};

export type BrowserNotice = {
  kind: 'popup-denied' | 'navigation-blocked';
  url: string;
  reason?: string;
};

export type BrowserDownload = {
  id: string;
  fileName: string;
  path?: string | null;
  state: 'started' | 'completed' | 'failed' | string;
};

export type EvalRequest = {
  requestId: string;
  tabId: string;
  pluginId?: string | null;
  origin?: string | null;
  title?: string | null;
  code: string;
  expiresAt: number;
};

const ACTIVITY_CAP = 50;
const EMPTY_ACTIVITY: AgentActivityEntry[] = [];
const EMPTY_DOWNLOADS: BrowserDownload[] = [];

const activity = new Map<string, AgentActivityEntry[]>();
const notices = new Map<string, BrowserNotice | null>();
const downloads = new Map<string, BrowserDownload[]>();
let evalRequest: EvalRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeBrowserChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentActivity(tabId: string): AgentActivityEntry[] {
  return activity.get(tabId) ?? EMPTY_ACTIVITY;
}

export function getBrowserNotice(tabId: string): BrowserNotice | null {
  return notices.get(tabId) ?? null;
}

export function getBrowserDownloads(tabId: string): BrowserDownload[] {
  return downloads.get(tabId) ?? EMPTY_DOWNLOADS;
}

export function getEvalRequest(): EvalRequest | null {
  return evalRequest;
}

export function recordAgentActivity(
  tabId: string,
  action: string,
  outcome: string,
  at = Date.now()
): void {
  const list = activity.get(tabId) ?? [];
  const head = list[0];
  if (head && head.action === action && head.outcome === outcome) {
    head.count += 1;
    head.at = at;
  } else {
    list.unshift({ action, outcome, at, count: 1 });
    if (list.length > ACTIVITY_CAP) list.length = ACTIVITY_CAP;
  }
  activity.set(tabId, list);
  emit();
}

export function clearAgentActivity(tabId: string): void {
  if (!activity.has(tabId)) return;
  activity.delete(tabId);
  emit();
}

export function setBrowserNotice(
  tabId: string,
  notice: BrowserNotice | null
): void {
  notices.set(tabId, notice);
  emit();
}

export function recordBrowserDownload(
  tabId: string,
  item: BrowserDownload
): void {
  const list = downloads.get(tabId) ?? [];
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) list[index] = item;
  else list.unshift(item);
  if (list.length > 8) list.length = 8;
  downloads.set(tabId, list);
  emit();
}

export function dismissBrowserDownload(tabId: string, id: string): void {
  const list = (downloads.get(tabId) ?? []).filter((item) => item.id !== id);
  downloads.set(tabId, list);
  emit();
}

export function setEvalRequest(next: EvalRequest | null): void {
  evalRequest = next;
  emit();
}

export function applyBrowserHostEvent(
  payload: {
    kind?: string;
    tabId?: string;
    sourceTabId?: string;
    url?: string;
    reason?: string;
    action?: string;
    outcome?: string;
    at?: number;
    requestId?: string;
    pluginId?: string | null;
    origin?: string | null;
    title?: string | null;
    code?: string;
    expiresAt?: number;
    state?: string;
    fileName?: string;
    path?: string | null;
  }
): void {
  const tabId = payload.tabId || payload.sourceTabId;
  if (payload.kind === 'agent.activity' && tabId && payload.action) {
    recordAgentActivity(
      tabId,
      payload.action,
      payload.outcome || 'done',
      payload.at ?? Date.now()
    );
    return;
  }
  if (payload.kind === 'popup.denied' && tabId) {
    setBrowserNotice(tabId, {
      kind: 'popup-denied',
      url: payload.url || '',
      reason: payload.reason,
    });
    return;
  }
  if (payload.kind === 'navigation.blocked' && tabId) {
    setBrowserNotice(tabId, {
      kind: 'navigation-blocked',
      url: payload.url || '',
      reason: payload.reason,
    });
    return;
  }
  if (payload.kind === 'eval.request' && payload.requestId && payload.code) {
    setEvalRequest({
      requestId: payload.requestId,
      tabId: payload.tabId || '',
      pluginId: payload.pluginId,
      origin: payload.origin,
      title: payload.title,
      code: payload.code,
      expiresAt: payload.expiresAt ?? Date.now() + 120_000,
    });
    return;
  }
  if (payload.kind === 'download' && tabId && payload.fileName) {
    recordBrowserDownload(tabId, {
      id: payload.path || `${payload.fileName}:${payload.url || ''}`,
      fileName: payload.fileName,
      path: payload.path,
      state: payload.state || 'started',
    });
  }
}

export function resetBrowserChromeForTests(): void {
  activity.clear();
  notices.clear();
  downloads.clear();
  evalRequest = null;
}
