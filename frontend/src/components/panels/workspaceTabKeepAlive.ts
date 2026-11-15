import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { DockviewPanelApi } from 'dockview-react';

export const DEFAULT_MAX_WARM_HIDDEN_PANELS = 5;
export const DEFAULT_KEEP_ALIVE_SCOPE = 'default';

export type KeepAliveDockviewPanelApi = Pick<DockviewPanelApi, 'id'> &
  Partial<
    Pick<
      DockviewPanelApi,
      'isVisible' | 'onDidVisibilityChange' | 'onDidActiveChange'
    >
  >;

export interface DockviewPanelKeepAliveOptions {
  scope?: string;
  maxWarmHidden?: number;
  pinned?: boolean;
}

export interface DockviewPanelKeepAliveState {
  readonly isVisible: boolean;
  readonly shouldKeepMounted: boolean;
}

interface PanelKeepAliveEntry {
  panelId: string;
  isVisible: boolean;
  pinned: boolean;
  maxWarmHidden: number;
  lastVisibleSeq: number;
  activeRegistrations: number;
}

const SNAPSHOT_VISIBLE_MOUNTED: DockviewPanelKeepAliveState = Object.freeze({
  isVisible: true,
  shouldKeepMounted: true,
});

const SNAPSHOT_HIDDEN_WARM: DockviewPanelKeepAliveState = Object.freeze({
  isVisible: false,
  shouldKeepMounted: true,
});

const SNAPSHOT_HIDDEN_HIBERNATED: DockviewPanelKeepAliveState = Object.freeze({
  isVisible: false,
  shouldKeepMounted: false,
});

const panelsByScope = new Map<string, Map<string, PanelKeepAliveEntry>>();
const listeners = new Set<() => void>();
let monotonicSeq = 0;

function nextSeq(): number {
  monotonicSeq += 1;
  return monotonicSeq;
}

function normalizeScope(scope?: string): string {
  return scope && scope.length > 0 ? scope : DEFAULT_KEEP_ALIVE_SCOPE;
}

function normalizeMaxWarmHidden(maxWarmHidden?: number): number {
  if (typeof maxWarmHidden !== 'number' || Number.isNaN(maxWarmHidden)) {
    return DEFAULT_MAX_WARM_HIDDEN_PANELS;
  }
  return Math.max(0, Math.floor(maxWarmHidden));
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribeKeepAlive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOrCreateScopeMap(scope: string): Map<string, PanelKeepAliveEntry> {
  let scopeMap = panelsByScope.get(scope);
  if (!scopeMap) {
    scopeMap = new Map();
    panelsByScope.set(scope, scopeMap);
  }
  return scopeMap;
}

function countUnpinnedHiddenPanels(
  scopeMap: Map<string, PanelKeepAliveEntry> | undefined
): number {
  if (!scopeMap) return 0;
  let count = 0;
  for (const entry of scopeMap.values()) {
    if (!entry.isVisible && !entry.pinned) {
      count += 1;
    }
  }
  return count;
}

function isWarmHiddenPanel(
  scopeMap: Map<string, PanelKeepAliveEntry>,
  target: PanelKeepAliveEntry
): boolean {
  if (target.maxWarmHidden <= 0) {
    return false;
  }
  // Rank `target` among unpinned hidden panels in descending `lastVisibleSeq`
  // order without allocating or sorting an array on every snapshot read: simply
  // count how many unpinned hidden peers strictly outrank `target`.
  let higherRankedPeers = 0;
  for (const candidate of scopeMap.values()) {
    if (candidate === target || candidate.isVisible || candidate.pinned) {
      continue;
    }
    if (candidate.lastVisibleSeq > target.lastVisibleSeq) {
      higherRankedPeers += 1;
      if (higherRankedPeers >= target.maxWarmHidden) {
        return false;
      }
    }
  }
  return true;
}

export function registerDockviewPanelKeepAlive(
  panelId: string,
  initial?: {
    scope?: string;
    isVisible?: boolean;
    pinned?: boolean;
    maxWarmHidden?: number;
  }
): () => void {
  const scope = normalizeScope(initial?.scope);
  const isVisible = initial?.isVisible ?? true;
  const pinned = Boolean(initial?.pinned);
  const maxWarmHidden = normalizeMaxWarmHidden(initial?.maxWarmHidden);
  const scopeMap = getOrCreateScopeMap(scope);
  const existing = scopeMap.get(panelId);

  if (existing) {
    existing.activeRegistrations += 1;
    const visibilityChanged = existing.isVisible !== isVisible;
    existing.pinned = pinned;
    existing.maxWarmHidden = maxWarmHidden;
    if (visibilityChanged || isVisible) {
      existing.isVisible = isVisible;
      existing.lastVisibleSeq = nextSeq();
    }
  } else {
    scopeMap.set(panelId, {
      panelId,
      isVisible,
      pinned,
      maxWarmHidden,
      lastVisibleSeq: nextSeq(),
      activeRegistrations: 1,
    });
  }

  emitChange();

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const currentScopeMap = panelsByScope.get(scope);
    const current = currentScopeMap?.get(panelId);
    if (!currentScopeMap || !current) return;

    current.activeRegistrations -= 1;
    if (current.activeRegistrations <= 0) {
      currentScopeMap.delete(panelId);
      if (currentScopeMap.size === 0) {
        panelsByScope.delete(scope);
      }
      emitChange();
    }
  };
}

export function updateDockviewPanelKeepAlive(
  panelId: string,
  patch: {
    scope?: string;
    isVisible?: boolean;
    pinned?: boolean;
    maxWarmHidden?: number;
  }
): void {
  const scope = normalizeScope(patch.scope);
  const scopeMap = panelsByScope.get(scope);
  const entry = scopeMap?.get(panelId);
  if (!entry) return;

  let changed = false;

  if (typeof patch.pinned === 'boolean' && entry.pinned !== patch.pinned) {
    entry.pinned = patch.pinned;
    changed = true;
  }

  if (patch.maxWarmHidden !== undefined) {
    const nextMax = normalizeMaxWarmHidden(patch.maxWarmHidden);
    if (entry.maxWarmHidden !== nextMax) {
      entry.maxWarmHidden = nextMax;
      changed = true;
    }
  }

  if (typeof patch.isVisible === 'boolean') {
    if (entry.isVisible !== patch.isVisible) {
      entry.isVisible = patch.isVisible;
      entry.lastVisibleSeq = nextSeq();
      changed = true;
    } else if (patch.isVisible) {
      entry.lastVisibleSeq = nextSeq();
    }
  }

  if (changed) {
    emitChange();
  }
}

export function unregisterDockviewPanelKeepAlive(
  panelId: string,
  scope?: string
): void {
  const normalizedScope = normalizeScope(scope);
  const scopeMap = panelsByScope.get(normalizedScope);
  if (!scopeMap || !scopeMap.delete(panelId)) {
    return;
  }
  if (scopeMap.size === 0) {
    panelsByScope.delete(normalizedScope);
  }
  emitChange();
}

export function getDockviewPanelKeepAliveState(
  panelId: string,
  options?: {
    scope?: string;
    fallbackIsVisible?: boolean;
    pinned?: boolean;
    maxWarmHidden?: number;
  }
): DockviewPanelKeepAliveState {
  const scope = normalizeScope(options?.scope);
  const scopeMap = panelsByScope.get(scope);
  const entry = scopeMap?.get(panelId);

  if (!entry) {
    const isVisible = options?.fallbackIsVisible ?? true;
    if (isVisible) {
      return SNAPSHOT_VISIBLE_MOUNTED;
    }
    if (options?.pinned) {
      return SNAPSHOT_HIDDEN_WARM;
    }
    const maxWarmHidden = normalizeMaxWarmHidden(options?.maxWarmHidden);
    return countUnpinnedHiddenPanels(scopeMap) < maxWarmHidden
      ? SNAPSHOT_HIDDEN_WARM
      : SNAPSHOT_HIDDEN_HIBERNATED;
  }

  if (entry.isVisible) {
    return SNAPSHOT_VISIBLE_MOUNTED;
  }

  if (entry.pinned) {
    return SNAPSHOT_HIDDEN_WARM;
  }

  return scopeMap && isWarmHiddenPanel(scopeMap, entry)
    ? SNAPSHOT_HIDDEN_WARM
    : SNAPSHOT_HIDDEN_HIBERNATED;
}

export function resetDockviewPanelKeepAliveStore(scope?: string): void {
  if (scope !== undefined) {
    const normalizedScope = normalizeScope(scope);
    if (panelsByScope.delete(normalizedScope)) {
      emitChange();
    }
    return;
  }

  const hadEntries = panelsByScope.size > 0;
  panelsByScope.clear();
  monotonicSeq = 0;
  if (hadEntries) {
    emitChange();
  }
}

export function useDockviewPanelKeepAlive(
  api: KeepAliveDockviewPanelApi | undefined,
  options?: DockviewPanelKeepAliveOptions
): DockviewPanelKeepAliveState {
  const scope = normalizeScope(options?.scope);
  const pinned = Boolean(options?.pinned);
  const maxWarmHidden = normalizeMaxWarmHidden(options?.maxWarmHidden);
  const panelId = api?.id;
  const fallbackIsVisible =
    typeof api?.isVisible === 'boolean' ? api.isVisible : true;

  const latestOptionsRef = useRef({ pinned, maxWarmHidden });

  useLayoutEffect(() => {
    latestOptionsRef.current = { pinned, maxWarmHidden };
    if (!panelId) return;
    updateDockviewPanelKeepAlive(panelId, {
      scope,
      pinned,
      maxWarmHidden,
    });
  }, [maxWarmHidden, panelId, pinned, scope]);

  useLayoutEffect(() => {
    if (!api || !panelId) return;

    let lastApiVisible =
      typeof api.isVisible === 'boolean' ? api.isVisible : true;

    const release = registerDockviewPanelKeepAlive(panelId, {
      scope,
      isVisible: lastApiVisible,
      pinned: latestOptionsRef.current.pinned,
      maxWarmHidden: latestOptionsRef.current.maxWarmHidden,
    });

    const visibilityDisposable = api.onDidVisibilityChange?.((event) => {
      const nextVisible =
        typeof event?.isVisible === 'boolean'
          ? event.isVisible
          : typeof api.isVisible === 'boolean'
            ? api.isVisible
            : true;
      if (typeof api.isVisible === 'boolean') {
        lastApiVisible = api.isVisible;
      }
      updateDockviewPanelKeepAlive(panelId, {
        scope,
        isVisible: nextVisible,
      });
    });

    const activeDisposable = api.onDidActiveChange?.((event) => {
      if (
        typeof api.isVisible === 'boolean' &&
        api.isVisible !== lastApiVisible
      ) {
        lastApiVisible = api.isVisible;
        updateDockviewPanelKeepAlive(panelId, {
          scope,
          isVisible: api.isVisible,
        });
        return;
      }
      if (
        event?.isActive &&
        (typeof api.isVisible !== 'boolean' || api.isVisible)
      ) {
        updateDockviewPanelKeepAlive(panelId, {
          scope,
          isVisible: true,
        });
      }
    });

    return () => {
      visibilityDisposable?.dispose();
      activeDisposable?.dispose();
      release();
    };
  }, [api, panelId, scope]);

  return useSyncExternalStore(
    subscribeKeepAlive,
    () => {
      if (!panelId) {
        return SNAPSHOT_VISIBLE_MOUNTED;
      }
      return getDockviewPanelKeepAliveState(panelId, {
        scope,
        fallbackIsVisible,
        pinned,
        maxWarmHidden,
      });
    },
    () => SNAPSHOT_VISIBLE_MOUNTED
  );
}
