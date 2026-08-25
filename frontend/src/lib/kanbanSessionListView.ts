/**
 * Kanban session-list grouping preference. Persisted in localStorage and
 * synced across the settings window via the `storage` event, matching
 * layout arrangement.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const KANBAN_SESSION_LIST_VIEWS = ['status', 'workspace'] as const;
export type KanbanSessionListView = (typeof KANBAN_SESSION_LIST_VIEWS)[number];

export const DEFAULT_KANBAN_SESSION_LIST_VIEW: KanbanSessionListView = 'status';
export const KANBAN_SESSION_LIST_VIEW_KEY =
  'vibex:kanban-session-list-view' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: KanbanSessionListView = DEFAULT_KANBAN_SESSION_LIST_VIEW;
let storageListenerInstalled = false;

function isKanbanSessionListView(
  value: unknown
): value is KanbanSessionListView {
  return (
    typeof value === 'string' &&
    KANBAN_SESSION_LIST_VIEWS.includes(value as KanbanSessionListView)
  );
}

function read(): KanbanSessionListView {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KANBAN_SESSION_LIST_VIEW_KEY);
  } catch {
    return DEFAULT_KANBAN_SESSION_LIST_VIEW;
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = isKanbanSessionListView(raw)
    ? raw
    : DEFAULT_KANBAN_SESSION_LIST_VIEW;
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
    if (event.key !== null && event.key !== KANBAN_SESSION_LIST_VIEW_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(view: KanbanSessionListView) {
  try {
    localStorage.setItem(KANBAN_SESSION_LIST_VIEW_KEY, view);
    persistFrontendPreference(KANBAN_SESSION_LIST_VIEW_KEY, view);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = view;
  cached = view;
  emit();
}

export function getKanbanSessionListView(): KanbanSessionListView {
  return read();
}

export function setKanbanSessionListView(view: KanbanSessionListView): void {
  if (!isKanbanSessionListView(view)) return;
  write(view);
}

export function resetKanbanSessionListView(): void {
  write(DEFAULT_KANBAN_SESSION_LIST_VIEW);
}

export function subscribeKanbanSessionListView(
  listener: () => void
): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKanbanSessionListView(): KanbanSessionListView {
  return useSyncExternalStore(
    subscribeKanbanSessionListView,
    getKanbanSessionListView,
    () => DEFAULT_KANBAN_SESSION_LIST_VIEW
  );
}
