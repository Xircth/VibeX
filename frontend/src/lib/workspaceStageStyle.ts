/**
 * Workspace B-zone stage presentation ('tabs' | 'canvas').
 * Persisted in localStorage and synced across the settings window via the
 * `storage` event, matching layout arrangement and kanban preferences.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export const WORKSPACE_STAGE_STYLES = ['tabs', 'canvas'] as const;
export type WorkspaceStageStyle = (typeof WORKSPACE_STAGE_STYLES)[number];

export const DEFAULT_WORKSPACE_STAGE_STYLE: WorkspaceStageStyle = 'tabs';
export const WORKSPACE_STAGE_STYLE_KEY = 'vibex:workspace-stage-style' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: WorkspaceStageStyle = DEFAULT_WORKSPACE_STAGE_STYLE;
let storageListenerInstalled = false;

export function isWorkspaceStageStyle(
  value: unknown
): value is WorkspaceStageStyle {
  return (
    typeof value === 'string' &&
    WORKSPACE_STAGE_STYLES.includes(value as WorkspaceStageStyle)
  );
}

function read(): WorkspaceStageStyle {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(WORKSPACE_STAGE_STYLE_KEY);
  } catch {
    return DEFAULT_WORKSPACE_STAGE_STYLE;
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = isWorkspaceStageStyle(raw) ? raw : DEFAULT_WORKSPACE_STAGE_STYLE;
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
    if (event.key !== null && event.key !== WORKSPACE_STAGE_STYLE_KEY) {
      return;
    }
    read();
    emit();
  });
}

function write(style: WorkspaceStageStyle) {
  try {
    localStorage.setItem(WORKSPACE_STAGE_STYLE_KEY, style);
    persistFrontendPreference(WORKSPACE_STAGE_STYLE_KEY, style);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = style;
  cached = style;
  emit();
}

export function getWorkspaceStageStyle(): WorkspaceStageStyle {
  return read();
}

export function setWorkspaceStageStyle(style: WorkspaceStageStyle): void {
  if (!isWorkspaceStageStyle(style)) return;
  write(style);
}

export function resetWorkspaceStageStyle(): void {
  write(DEFAULT_WORKSPACE_STAGE_STYLE);
}

export function subscribeWorkspaceStageStyle(
  listener: () => void
): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkspaceStageStyle(): WorkspaceStageStyle {
  return useSyncExternalStore(
    subscribeWorkspaceStageStyle,
    getWorkspaceStageStyle,
    () => DEFAULT_WORKSPACE_STAGE_STYLE
  );
}
