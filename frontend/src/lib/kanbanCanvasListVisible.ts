/**
 * Visibility of the kanban infinite-canvas session list overlay.
 * Persisted like other appearance chrome, independent of grouping.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const DEFAULT_KANBAN_CANVAS_LIST_VISIBLE = true;
export const KANBAN_CANVAS_LIST_VISIBLE_KEY =
  'vibex:kanban-canvas-list-visible' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached = DEFAULT_KANBAN_CANVAS_LIST_VISIBLE;
let storageListenerInstalled = false;

function parse(value: string | null): boolean {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return DEFAULT_KANBAN_CANVAS_LIST_VISIBLE;
}

function read(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KANBAN_CANVAS_LIST_VISIBLE_KEY);
  } catch {
    return DEFAULT_KANBAN_CANVAS_LIST_VISIBLE;
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = parse(raw);
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
    if (event.key !== null && event.key !== KANBAN_CANVAS_LIST_VISIBLE_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(visible: boolean) {
  const raw = String(visible);
  try {
    localStorage.setItem(KANBAN_CANVAS_LIST_VISIBLE_KEY, raw);
    persistFrontendPreference(KANBAN_CANVAS_LIST_VISIBLE_KEY, visible);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = raw;
  cached = visible;
  emit();
}

export function getKanbanCanvasListVisible(): boolean {
  return read();
}

export function setKanbanCanvasListVisible(visible: boolean): void {
  write(visible);
}

export function toggleKanbanCanvasListVisible(): void {
  write(!read());
}

export function resetKanbanCanvasListVisible(): void {
  write(DEFAULT_KANBAN_CANVAS_LIST_VISIBLE);
}

export function subscribeKanbanCanvasListVisible(
  listener: () => void
): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKanbanCanvasListVisible(): boolean {
  return useSyncExternalStore(
    subscribeKanbanCanvasListVisible,
    getKanbanCanvasListVisible,
    () => DEFAULT_KANBAN_CANVAS_LIST_VISIBLE
  );
}
