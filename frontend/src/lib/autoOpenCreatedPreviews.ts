/**
 * Whether a newly created SVG or HTML file opens its preview on its own while
 * the workspace page is on screen. Persisted like other appearance chrome.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const DEFAULT_AUTO_OPEN_CREATED_PREVIEWS = true;
export const AUTO_OPEN_CREATED_PREVIEWS_KEY =
  'vibex:auto-open-created-previews' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached = DEFAULT_AUTO_OPEN_CREATED_PREVIEWS;
let storageListenerInstalled = false;

function parse(value: string | null): boolean {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return DEFAULT_AUTO_OPEN_CREATED_PREVIEWS;
}

function read(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(AUTO_OPEN_CREATED_PREVIEWS_KEY);
  } catch {
    return DEFAULT_AUTO_OPEN_CREATED_PREVIEWS;
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
    if (event.key !== null && event.key !== AUTO_OPEN_CREATED_PREVIEWS_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(enabled: boolean) {
  const raw = String(enabled);
  try {
    localStorage.setItem(AUTO_OPEN_CREATED_PREVIEWS_KEY, raw);
    persistFrontendPreference(AUTO_OPEN_CREATED_PREVIEWS_KEY, enabled);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = raw;
  cached = enabled;
  emit();
}

export function getAutoOpenCreatedPreviews(): boolean {
  return read();
}

export function setAutoOpenCreatedPreviews(enabled: boolean): void {
  write(enabled);
}

export function subscribeAutoOpenCreatedPreviews(
  listener: () => void
): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAutoOpenCreatedPreviews(): boolean {
  return useSyncExternalStore(
    subscribeAutoOpenCreatedPreviews,
    getAutoOpenCreatedPreviews,
    () => DEFAULT_AUTO_OPEN_CREATED_PREVIEWS
  );
}
