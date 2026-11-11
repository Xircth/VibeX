/**
 * Workspace panel view ('tabs' | 'canvas') and infinite-canvas bar positions.
 * Persisted in localStorage and synced across the settings window via the
 * `storage` event, matching layout arrangement and kanban preferences.
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

type PersistableKey =
  | 'vibex:workspace-stage-style'
  | 'vibex:canvas-dock-position'
  | 'vibex:canvas-viewport-position';

function createEnumPreferenceStore<T extends string>(
  storageKey: PersistableKey,
  allowedValues: readonly T[],
  defaultValue: T
) {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null = null;
  let cached: T = defaultValue;
  let storageListenerInstalled = false;

  const isValid = (value: unknown): value is T =>
    typeof value === 'string' && allowedValues.includes(value as T);

  const read = (): T => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return defaultValue;
    }

    if (raw === cachedRaw) return cached;

    cachedRaw = raw;
    cached = isValid(raw) ? raw : defaultValue;
    return cached;
  };

  const emit = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const installStorageListener = () => {
    if (storageListenerInstalled || typeof window === 'undefined') return;

    storageListenerInstalled = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== storageKey) {
        return;
      }
      read();
      emit();
    });
  };

  const write = (value: T) => {
    try {
      localStorage.setItem(storageKey, value);
      persistFrontendPreference(storageKey, value);
    } catch {
      // Keep the in-memory value even when persistence is unavailable.
    }

    cachedRaw = value;
    cached = value;
    emit();
  };

  const get = (): T => read();

  const set = (value: T): void => {
    if (!isValid(value)) return;
    write(value);
  };

  const reset = (): void => {
    write(defaultValue);
  };

  const subscribe = (listener: () => void): (() => void) => {
    installStorageListener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const useValue = (): T =>
    useSyncExternalStore(subscribe, get, () => defaultValue);

  return { isValid, get, set, reset, subscribe, useValue };
}

export const WORKSPACE_STAGE_STYLES = ['tabs', 'canvas'] as const;
export type WorkspaceStageStyle = (typeof WORKSPACE_STAGE_STYLES)[number];
export const DEFAULT_WORKSPACE_STAGE_STYLE: WorkspaceStageStyle = 'tabs';
export const WORKSPACE_STAGE_STYLE_KEY = 'vibex:workspace-stage-style' as const;

const stageStyleStore = createEnumPreferenceStore(
  WORKSPACE_STAGE_STYLE_KEY,
  WORKSPACE_STAGE_STYLES,
  DEFAULT_WORKSPACE_STAGE_STYLE
);

export const isWorkspaceStageStyle = stageStyleStore.isValid;
export const getWorkspaceStageStyle = stageStyleStore.get;
export const setWorkspaceStageStyle = stageStyleStore.set;
export const resetWorkspaceStageStyle = stageStyleStore.reset;
export const subscribeWorkspaceStageStyle = stageStyleStore.subscribe;
export const useWorkspaceStageStyle = stageStyleStore.useValue;

export const CANVAS_DOCK_POSITIONS = ['bottom', 'left', 'right'] as const;
export type CanvasDockPosition = (typeof CANVAS_DOCK_POSITIONS)[number];
export const DEFAULT_CANVAS_DOCK_POSITION: CanvasDockPosition = 'bottom';
export const CANVAS_DOCK_POSITION_KEY = 'vibex:canvas-dock-position' as const;

const canvasDockPositionStore = createEnumPreferenceStore(
  CANVAS_DOCK_POSITION_KEY,
  CANVAS_DOCK_POSITIONS,
  DEFAULT_CANVAS_DOCK_POSITION
);

export const isCanvasDockPosition = canvasDockPositionStore.isValid;
export const getCanvasDockPosition = canvasDockPositionStore.get;
export const setCanvasDockPosition = canvasDockPositionStore.set;
export const resetCanvasDockPosition = canvasDockPositionStore.reset;
export const subscribeCanvasDockPosition = canvasDockPositionStore.subscribe;
export const useCanvasDockPosition = canvasDockPositionStore.useValue;

export const CANVAS_VIEWPORT_POSITIONS = [
  'bottom-left',
  'bottom-right',
] as const;
export type CanvasViewportPosition = (typeof CANVAS_VIEWPORT_POSITIONS)[number];
export const DEFAULT_CANVAS_VIEWPORT_POSITION: CanvasViewportPosition =
  'bottom-right';
export const CANVAS_VIEWPORT_POSITION_KEY =
  'vibex:canvas-viewport-position' as const;

const canvasViewportPositionStore = createEnumPreferenceStore(
  CANVAS_VIEWPORT_POSITION_KEY,
  CANVAS_VIEWPORT_POSITIONS,
  DEFAULT_CANVAS_VIEWPORT_POSITION
);

export const isCanvasViewportPosition = canvasViewportPositionStore.isValid;
export const getCanvasViewportPosition = canvasViewportPositionStore.get;
export const setCanvasViewportPosition = canvasViewportPositionStore.set;
export const resetCanvasViewportPosition = canvasViewportPositionStore.reset;
export const subscribeCanvasViewportPosition =
  canvasViewportPositionStore.subscribe;
export const useCanvasViewportPosition = canvasViewportPositionStore.useValue;
