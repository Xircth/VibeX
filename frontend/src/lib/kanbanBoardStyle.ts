/**
 * Kanban session-hub presentation. Persisted in localStorage and synced
 * across the settings window via the `storage` event, matching session-list
 * grouping.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const KANBAN_BOARD_STYLES = ['fixed', 'canvas'] as const;
export type KanbanBoardStyle = (typeof KANBAN_BOARD_STYLES)[number];

export const DEFAULT_KANBAN_BOARD_STYLE: KanbanBoardStyle = 'fixed';
export const KANBAN_BOARD_STYLE_KEY = 'vibex:kanban-board-style' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: KanbanBoardStyle = DEFAULT_KANBAN_BOARD_STYLE;
let storageListenerInstalled = false;

function isKanbanBoardStyle(value: unknown): value is KanbanBoardStyle {
  return (
    typeof value === 'string' &&
    KANBAN_BOARD_STYLES.includes(value as KanbanBoardStyle)
  );
}

function read(): KanbanBoardStyle {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KANBAN_BOARD_STYLE_KEY);
  } catch {
    return DEFAULT_KANBAN_BOARD_STYLE;
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = isKanbanBoardStyle(raw) ? raw : DEFAULT_KANBAN_BOARD_STYLE;
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
    if (event.key !== null && event.key !== KANBAN_BOARD_STYLE_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(style: KanbanBoardStyle) {
  try {
    localStorage.setItem(KANBAN_BOARD_STYLE_KEY, style);
    persistFrontendPreference(KANBAN_BOARD_STYLE_KEY, style);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = style;
  cached = style;
  emit();
}

export function getKanbanBoardStyle(): KanbanBoardStyle {
  return read();
}

export function setKanbanBoardStyle(style: KanbanBoardStyle): void {
  if (!isKanbanBoardStyle(style)) return;
  write(style);
}

export function resetKanbanBoardStyle(): void {
  write(DEFAULT_KANBAN_BOARD_STYLE);
}

export function subscribeKanbanBoardStyle(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKanbanBoardStyle(): KanbanBoardStyle {
  return useSyncExternalStore(
    subscribeKanbanBoardStyle,
    getKanbanBoardStyle,
    () => DEFAULT_KANBAN_BOARD_STYLE
  );
}
