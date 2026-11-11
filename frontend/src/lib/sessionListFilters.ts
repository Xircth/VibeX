import { useSyncExternalStore } from 'react';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  getHideBotSessions,
  setHideBotSessions,
  useHideBotSessions,
} from '@/lib/hideBotSessions';
import { dateTimestamp } from '@/utils/date';

export { getHideBotSessions, setHideBotSessions, useHideBotSessions };

export const DEFAULT_HIDE_DEFAULT_WORKSPACE = false;
export const HIDE_DEFAULT_WORKSPACE_KEY =
  'vibex:hide-default-workspace' as const;

export const DEFAULT_HIDE_INACTIVE_SESSIONS = false;
export const HIDE_INACTIVE_SESSIONS_KEY =
  'vibex:hide-inactive-7d-sessions' as const;

export const INACTIVE_SESSION_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

interface BooleanPreferenceStore {
  get: () => boolean;
  set: (enabled: boolean) => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
  useValue: () => boolean;
}

function createBooleanPreferenceStore(
  storageKey:
    | typeof HIDE_DEFAULT_WORKSPACE_KEY
    | typeof HIDE_INACTIVE_SESSIONS_KEY,
  defaultValue: boolean
): BooleanPreferenceStore {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null = null;
  let cached = defaultValue;
  let storageListenerInstalled = false;

  function parse(value: string | null): boolean {
    if (value === 'false') return false;
    if (value === 'true') return true;
    return defaultValue;
  }

  function read(): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return defaultValue;
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
      if (event.key !== null && event.key !== storageKey) {
        return;
      }
      read();
      emit();
    });
  }

  function write(enabled: boolean) {
    const raw = String(enabled);
    try {
      localStorage.setItem(storageKey, raw);
      persistFrontendPreference(storageKey, enabled);
    } catch {
      // Keep the in-memory value even when persistence is unavailable.
    }

    cachedRaw = raw;
    cached = enabled;
    emit();
  }

  function subscribe(listener: () => void): () => void {
    installStorageListener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function useValue(): boolean {
    return useSyncExternalStore(subscribe, read, () => defaultValue);
  }

  return {
    get: read,
    set: write,
    reset: () => write(defaultValue),
    subscribe,
    useValue,
  };
}

const hideDefaultWorkspaceStore = createBooleanPreferenceStore(
  HIDE_DEFAULT_WORKSPACE_KEY,
  DEFAULT_HIDE_DEFAULT_WORKSPACE
);

const hideInactiveSessionsStore = createBooleanPreferenceStore(
  HIDE_INACTIVE_SESSIONS_KEY,
  DEFAULT_HIDE_INACTIVE_SESSIONS
);

export const getHideDefaultWorkspace = hideDefaultWorkspaceStore.get;
export const setHideDefaultWorkspace = hideDefaultWorkspaceStore.set;
export const resetHideDefaultWorkspace = hideDefaultWorkspaceStore.reset;
export const subscribeHideDefaultWorkspace =
  hideDefaultWorkspaceStore.subscribe;
export const useHideDefaultWorkspace = hideDefaultWorkspaceStore.useValue;

export const getHideInactiveSessions = hideInactiveSessionsStore.get;
export const setHideInactiveSessions = hideInactiveSessionsStore.set;
export const resetHideInactiveSessions = hideInactiveSessionsStore.reset;
export const subscribeHideInactiveSessions =
  hideInactiveSessionsStore.subscribe;
export const useHideInactiveSessions = hideInactiveSessionsStore.useValue;

export interface SessionListFilterPreferences {
  hideDefaultWorkspace?: boolean;
  hideBotSessions?: boolean;
  hideInactiveSessions?: boolean;
  now?: number;
}

export function isSessionInactiveForSevenDays(
  session: { updatedAt: string; isRunning?: boolean },
  now = Date.now()
): boolean {
  if (session.isRunning) {
    return false;
  }
  const updatedTimestamp = dateTimestamp(session.updatedAt);
  if (updatedTimestamp <= 0) {
    return false;
  }
  return now - updatedTimestamp >= INACTIVE_SESSION_THRESHOLD_MS;
}

export function filterSessionListPreferences<
  T extends {
    workspace: { use_worktree: boolean };
    collaboration?: unknown | null;
    updatedAt: string;
    isRunning?: boolean;
  },
>(sessions: readonly T[], preferences: SessionListFilterPreferences = {}): T[] {
  const {
    hideDefaultWorkspace = getHideDefaultWorkspace(),
    hideBotSessions = getHideBotSessions(),
    hideInactiveSessions = getHideInactiveSessions(),
    now = Date.now(),
  } = preferences;

  if (!hideDefaultWorkspace && !hideBotSessions && !hideInactiveSessions) {
    return sessions as T[];
  }

  return sessions.filter((session) => {
    if (hideDefaultWorkspace && !session.workspace.use_worktree) {
      return false;
    }
    if (hideBotSessions && Boolean(session.collaboration)) {
      return false;
    }
    if (hideInactiveSessions && isSessionInactiveForSevenDays(session, now)) {
      return false;
    }
    return true;
  });
}
