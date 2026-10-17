/**
 * Whether the settings window left menu uses a rounded floating panel.
 * Persisted like other appearance chrome.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const DEFAULT_SETTINGS_NAV_FLOAT = true;
export const SETTINGS_NAV_FLOAT_KEY = 'vibex:settings-nav-float' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached = DEFAULT_SETTINGS_NAV_FLOAT;
let storageListenerInstalled = false;

function parse(value: string | null): boolean {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return DEFAULT_SETTINGS_NAV_FLOAT;
}

function read(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_NAV_FLOAT_KEY);
  } catch {
    return DEFAULT_SETTINGS_NAV_FLOAT;
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
    if (event.key !== null && event.key !== SETTINGS_NAV_FLOAT_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(enabled: boolean) {
  const raw = String(enabled);
  try {
    localStorage.setItem(SETTINGS_NAV_FLOAT_KEY, raw);
    persistFrontendPreference(SETTINGS_NAV_FLOAT_KEY, enabled);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = raw;
  cached = enabled;
  emit();
}

export function getSettingsNavFloat(): boolean {
  return read();
}

export function setSettingsNavFloat(enabled: boolean): void {
  write(enabled);
}

export function resetSettingsNavFloat(): void {
  write(DEFAULT_SETTINGS_NAV_FLOAT);
}

export function subscribeSettingsNavFloat(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSettingsNavFloat(): boolean {
  return useSyncExternalStore(
    subscribeSettingsNavFloat,
    getSettingsNavFloat,
    () => DEFAULT_SETTINGS_NAV_FLOAT
  );
}
