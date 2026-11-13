import { createContext, useSyncExternalStore } from 'react';
import { persistFrontendPreference } from '@/lib/frontendPreferences';

export type SessionListAppearance = 'compact' | 'full';
export const SESSION_LIST_APPEARANCE_KEY = 'vibex:session-list-appearance';
export const SessionListAppearanceContext =
  createContext<SessionListAppearance>('compact');

const listeners = new Set<() => void>();
let listening = false;

export function getSessionListAppearance(): SessionListAppearance {
  try {
    return localStorage.getItem(SESSION_LIST_APPEARANCE_KEY) === 'full'
      ? 'full'
      : 'compact';
  } catch {
    return 'compact';
  }
}

export function setSessionListAppearance(value: SessionListAppearance) {
  try {
    localStorage.setItem(SESSION_LIST_APPEARANCE_KEY, value);
    persistFrontendPreference(SESSION_LIST_APPEARANCE_KEY, value);
  } catch {
    // Storage may be disabled in the current window.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('storage', (event) => {
      if (event.key === null || event.key === SESSION_LIST_APPEARANCE_KEY)
        for (const callback of listeners) callback();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionListAppearance() {
  return useSyncExternalStore(
    subscribe,
    getSessionListAppearance,
    () => 'compact' as const
  );
}
