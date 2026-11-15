import { useCallback, useSyncExternalStore } from 'react';
import i18n from '@/i18n';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  confirmDiscardMergePanel,
  hasAnyDirtyMergePanel,
  isMergePanelDirty,
  resetMergePanelDirtyForTests,
  subscribeAnyMergePanelDirty,
  subscribeMergePanelDirty,
} from './merge/mergePanelDirty';

const dirtyPanelLabels = new Map<string, string | null>();
const listenersByPanelId = new Map<string, Set<() => void>>();

let isBeforeUnloadAttached = false;
let unsubscribeMergeUnloadSync: (() => void) | null = null;

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirtyPanelLabels.size === 0 && !hasAnyDirtyMergePanel()) {
    return;
  }
  event.preventDefault();
  event.returnValue = '';
}

function syncBeforeUnloadListener(): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (!unsubscribeMergeUnloadSync) {
    unsubscribeMergeUnloadSync = subscribeAnyMergePanelDirty(() => {
      syncBeforeUnloadListener();
    });
  }
  const shouldAttach = dirtyPanelLabels.size > 0 || hasAnyDirtyMergePanel();
  if (shouldAttach && !isBeforeUnloadAttached) {
    window.addEventListener('beforeunload', handleBeforeUnload);
    isBeforeUnloadAttached = true;
  } else if (!shouldAttach && isBeforeUnloadAttached) {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    isBeforeUnloadAttached = false;
  }
}

function notifyPanelListeners(panelId: string): void {
  syncBeforeUnloadListener();
  const panelListeners = listenersByPanelId.get(panelId);
  if (!panelListeners || panelListeners.size === 0) {
    return;
  }
  for (const listener of [...panelListeners]) {
    listener();
  }
}

export function setPreviewPanelDirty(
  panelId: string,
  dirty: boolean,
  fileLabel?: string | null
): void {
  if (!panelId) {
    return;
  }
  if (dirty) {
    const wasDirty = dirtyPanelLabels.has(panelId);
    const normalizedLabel = fileLabel?.trim() ? fileLabel.trim() : null;
    dirtyPanelLabels.set(panelId, normalizedLabel);
    if (!wasDirty) {
      notifyPanelListeners(panelId);
    }
    return;
  }
  if (dirtyPanelLabels.delete(panelId)) {
    notifyPanelListeners(panelId);
  }
}

export function isPreviewPanelDirty(panelId: string): boolean {
  return Boolean(panelId) && dirtyPanelLabels.has(panelId);
}

function subscribePreviewDirty(
  panelId: string,
  listener: () => void
): () => void {
  if (!panelId) {
    return () => {};
  }
  let listeners = listenersByPanelId.get(panelId);
  if (!listeners) {
    listeners = new Set();
    listenersByPanelId.set(panelId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByPanelId.get(panelId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listenersByPanelId.delete(panelId);
    }
  };
}

export function useIsPreviewPanelDirty(panelId: string | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      panelId ? subscribePreviewDirty(panelId, listener) : () => {},
    [panelId]
  );

  const getSnapshot = useCallback(
    () => (panelId ? dirtyPanelLabels.has(panelId) : false),
    [panelId]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useIsWorkspacePanelDirty(
  panelId: string | undefined,
  componentId?: string | null
): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!panelId) {
        return () => {};
      }
      const unsubPreview = subscribePreviewDirty(panelId, listener);
      const unsubMerge =
        !componentId || componentId === PANEL_IDS.MERGE
          ? subscribeMergePanelDirty(panelId, listener)
          : () => {};
      return () => {
        unsubPreview();
        unsubMerge();
      };
    },
    [componentId, panelId]
  );

  const getSnapshot = useCallback(() => {
    if (!panelId) {
      return false;
    }
    if (dirtyPanelLabels.has(panelId)) {
      return true;
    }
    return (
      (!componentId || componentId === PANEL_IDS.MERGE) &&
      isMergePanelDirty(panelId)
    );
  }, [componentId, panelId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function confirmDiscardPreviewPanel(panelId: string): boolean {
  if (!isPreviewPanelDirty(panelId)) {
    return true;
  }
  const fileLabel = dirtyPanelLabels.get(panelId) ?? null;
  const activeLanguage = (
    i18n.resolvedLanguage ??
    i18n.language ??
    ''
  ).toLowerCase();
  const isZh = activeLanguage.startsWith('zh');

  const message = fileLabel
    ? i18n.t('panels:ui.preview.confirmDiscardNamed', {
        name: fileLabel,
        defaultValue: isZh
          ? '文件 “{{name}}” 有未保存的修改，确定放弃并关闭吗？'
          : 'Discard unsaved changes in "{{name}}"?',
      })
    : i18n.t('panels:ui.preview.confirmDiscard', {
        defaultValue: isZh
          ? '放弃未保存的文件修改？'
          : 'Discard unsaved changes?',
      });

  return window.confirm(message);
}

export function confirmCloseWorkspacePanel(
  panelId: string,
  componentId?: string | null
): boolean {
  if (
    (!componentId || componentId === PANEL_IDS.MERGE) &&
    !confirmDiscardMergePanel(panelId)
  ) {
    return false;
  }
  return confirmDiscardPreviewPanel(panelId);
}

export function resetPreviewPanelDirtyForTests(): void {
  const dirtyIds = [...dirtyPanelLabels.keys()];
  dirtyPanelLabels.clear();
  resetMergePanelDirtyForTests();
  syncBeforeUnloadListener();
  for (const panelId of dirtyIds) {
    notifyPanelListeners(panelId);
  }
}
