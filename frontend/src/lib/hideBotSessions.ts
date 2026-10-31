/**
 * Whether sessions belonging to Collaboration Space Bots are hidden in Kanban
 * and Workspace session lists. Persisted like other frontend preferences.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const DEFAULT_HIDE_BOT_SESSIONS = false;
export const HIDE_BOT_SESSIONS_KEY = 'vibex:hide-bot-sessions' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached = DEFAULT_HIDE_BOT_SESSIONS;
let storageListenerInstalled = false;

function parse(value: string | null): boolean {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return DEFAULT_HIDE_BOT_SESSIONS;
}

function read(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(HIDE_BOT_SESSIONS_KEY);
  } catch {
    return DEFAULT_HIDE_BOT_SESSIONS;
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
    if (event.key !== null && event.key !== HIDE_BOT_SESSIONS_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(enabled: boolean) {
  const raw = String(enabled);
  try {
    localStorage.setItem(HIDE_BOT_SESSIONS_KEY, raw);
    persistFrontendPreference(HIDE_BOT_SESSIONS_KEY, enabled);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = raw;
  cached = enabled;
  emit();
}

export function getHideBotSessions(): boolean {
  return read();
}

export function setHideBotSessions(enabled: boolean): void {
  write(enabled);
}

export function resetHideBotSessions(): void {
  write(DEFAULT_HIDE_BOT_SESSIONS);
}

export function subscribeHideBotSessions(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHideBotSessions(): boolean {
  return useSyncExternalStore(
    subscribeHideBotSessions,
    getHideBotSessions,
    () => DEFAULT_HIDE_BOT_SESSIONS
  );
}

export function filterVisibleBotSessions<
  T extends { collaboration?: unknown | null },
>(sessions: readonly T[], hideBotSessions = getHideBotSessions()): T[] {
  if (!hideBotSessions) return sessions as T[];
  return sessions.filter((session) => !session.collaboration);
}
