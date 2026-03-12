import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";

export const MAX_PINS_SOFT_LIMIT = 5;

export type ThreadActivityMap = Record<string, Record<string, number>>;
export type PinnedThreadsMap = Record<string, number>;
export type CustomNamesMap = Record<string, string>;
export type AutoTitlePendingMap = Record<string, true>;

export function loadThreadActivity(): ThreadActivityMap {
  return getClientStoreSync<ThreadActivityMap>("threads", "lastUserActivity") ?? {};
}

export function saveThreadActivity(activity: ThreadActivityMap) {
  writeClientStoreValue("threads", "lastUserActivity", activity);
}

export function makeCustomNameKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`;
}

export function loadCustomNames(): CustomNamesMap {
  return getClientStoreSync<CustomNamesMap>("threads", "customNames") ?? {};
}

export function saveCustomName(workspaceId: string, threadId: string, name: string): void {
  const current = loadCustomNames();
  const key = makeCustomNameKey(workspaceId, threadId);
  const updated = { ...current, [key]: name };
  writeClientStoreValue("threads", "customNames", updated);
}

export function loadAutoTitlePending(): AutoTitlePendingMap {
  const raw = getClientStoreSync<AutoTitlePendingMap>("threads", "autoTitlePending") ?? {};
  const normalized: AutoTitlePendingMap = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (key.trim() && value === true) {
      normalized[key] = true;
    }
  });
  return normalized;
}

export function saveAutoTitlePending(value: AutoTitlePendingMap): void {
  writeClientStoreValue("threads", "autoTitlePending", value);
}

export function makePinKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`;
}

export function loadPinnedThreads(): PinnedThreadsMap {
  return getClientStoreSync<PinnedThreadsMap>("threads", "pinnedThreads") ?? {};
}

export function savePinnedThreads(pinned: PinnedThreadsMap) {
  writeClientStoreValue("threads", "pinnedThreads", pinned);
}
