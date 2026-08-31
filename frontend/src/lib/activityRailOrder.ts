/**
 * Workspace activity-rail order. The first item is the default left dock
 * panel for a new or reset layout. Persisted in localStorage and synced
 * through frontend preferences, matching layout arrangement.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { PANEL_IDS } from '@/stores/useLayoutStore';

export const ACTIVITY_RAIL_ITEMS = [
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
  PANEL_IDS.SESSION_LIST,
] as const;

export type ActivityRailItemId = (typeof ACTIVITY_RAIL_ITEMS)[number];

export const DEFAULT_ACTIVITY_RAIL_ORDER: readonly ActivityRailItemId[] =
  ACTIVITY_RAIL_ITEMS;

export const ACTIVITY_RAIL_PANEL_TITLES: Record<ActivityRailItemId, string> = {
  [PANEL_IDS.FILE_TREE]: 'Files',
  [PANEL_IDS.GIT]: 'Git',
  [PANEL_IDS.SEARCH]: 'Search',
  [PANEL_IDS.SESSION_LIST]: 'Sessions',
};

export const ACTIVITY_RAIL_ORDER_KEY = 'vibex:activity-rail-order' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: ActivityRailItemId[] = [...DEFAULT_ACTIVITY_RAIL_ORDER];
let storageListenerInstalled = false;

export function isActivityRailItemId(
  value: unknown
): value is ActivityRailItemId {
  return (
    typeof value === 'string' &&
    (ACTIVITY_RAIL_ITEMS as readonly string[]).includes(value)
  );
}

export function sanitizeActivityRailOrder(
  value: unknown
): ActivityRailItemId[] {
  const seen = new Set<ActivityRailItemId>();
  const next: ActivityRailItemId[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isActivityRailItemId(item) || seen.has(item)) continue;
      seen.add(item);
      next.push(item);
    }
  }

  for (const item of DEFAULT_ACTIVITY_RAIL_ORDER) {
    if (seen.has(item)) continue;
    next.push(item);
  }

  return next;
}

export function moveActivityRailItem(
  order: readonly ActivityRailItemId[],
  activeId: string,
  overId: string
): ActivityRailItemId[] | null {
  const from = order.indexOf(activeId as ActivityRailItemId);
  const to = order.indexOf(overId as ActivityRailItemId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = order.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function nudgeActivityRailItem(
  order: readonly ActivityRailItemId[],
  itemId: string,
  direction: -1 | 1
): ActivityRailItemId[] | null {
  const from = order.indexOf(itemId as ActivityRailItemId);
  if (from < 0) return null;
  const to = from + direction;
  if (to < 0 || to >= order.length) return null;
  return moveActivityRailItem(order, itemId, order[to]);
}

export function otherActivityRailPanels(
  targetId: string
): ActivityRailItemId[] {
  return ACTIVITY_RAIL_ITEMS.filter((id) => id !== targetId);
}

function parseStoredOrder(raw: string | null): ActivityRailItemId[] {
  if (raw == null) return [...DEFAULT_ACTIVITY_RAIL_ORDER];
  try {
    return sanitizeActivityRailOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_ACTIVITY_RAIL_ORDER];
  }
}

function read(): ActivityRailItemId[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ACTIVITY_RAIL_ORDER_KEY);
  } catch {
    return [...DEFAULT_ACTIVITY_RAIL_ORDER];
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = parseStoredOrder(raw);
  return cached;
}

function emit() {
  for (const listener of [...listeners]) {
    listener();
  }
}

function installStorageListener() {
  if (storageListenerInstalled || typeof window === 'undefined') return;

  storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ACTIVITY_RAIL_ORDER_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(order: ActivityRailItemId[]) {
  const next = sanitizeActivityRailOrder(order);
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(ACTIVITY_RAIL_ORDER_KEY, raw);
    persistFrontendPreference(ACTIVITY_RAIL_ORDER_KEY, next);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = raw;
  cached = next;
  emit();
}

export function getActivityRailOrder(): ActivityRailItemId[] {
  return read();
}

export function getDefaultActivityRailPanelId(): ActivityRailItemId {
  return read()[0] ?? PANEL_IDS.FILE_TREE;
}

export function setActivityRailOrder(order: ActivityRailItemId[]): void {
  write(order);
}

export function resetActivityRailOrder(): void {
  write([...DEFAULT_ACTIVITY_RAIL_ORDER]);
}

export function subscribeActivityRailOrder(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActivityRailOrder(): ActivityRailItemId[] {
  return useSyncExternalStore(
    subscribeActivityRailOrder,
    getActivityRailOrder,
    () => [...DEFAULT_ACTIVITY_RAIL_ORDER]
  );
}
