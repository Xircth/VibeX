const dirtyPanels = new Set<string>();
const listenersByPanelId = new Map<string, Set<() => void>>();
const globalMergeDirtyListeners = new Set<() => void>();

function notifyMergePanelListeners(panelId: string) {
  const listeners = listenersByPanelId.get(panelId);
  if (listeners) {
    for (const listener of [...listeners]) {
      listener();
    }
  }
  for (const listener of [...globalMergeDirtyListeners]) {
    listener();
  }
}

export function setMergePanelDirty(panelId: string, dirty: boolean) {
  if (!panelId) return;
  if (dirty) {
    if (!dirtyPanels.has(panelId)) {
      dirtyPanels.add(panelId);
      notifyMergePanelListeners(panelId);
    }
    return;
  }
  if (dirtyPanels.delete(panelId)) {
    notifyMergePanelListeners(panelId);
  }
}

export function isMergePanelDirty(panelId: string): boolean {
  return Boolean(panelId) && dirtyPanels.has(panelId);
}

export function hasAnyDirtyMergePanel(): boolean {
  return dirtyPanels.size > 0;
}

export function subscribeMergePanelDirty(
  panelId: string,
  listener: () => void
): () => void {
  if (!panelId) return () => {};
  let set = listenersByPanelId.get(panelId);
  if (!set) {
    set = new Set();
    listenersByPanelId.set(panelId, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByPanelId.get(panelId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByPanelId.delete(panelId);
    }
  };
}

export function subscribeAnyMergePanelDirty(listener: () => void): () => void {
  globalMergeDirtyListeners.add(listener);
  return () => {
    globalMergeDirtyListeners.delete(listener);
  };
}

export function confirmDiscardMergePanel(panelId: string): boolean {
  if (!isMergePanelDirty(panelId)) return true;
  return window.confirm('Discard unsaved conflict resolution?');
}

export function resetMergePanelDirtyForTests(): void {
  const ids = [...dirtyPanels];
  dirtyPanels.clear();
  for (const id of ids) {
    notifyMergePanelListeners(id);
  }
}
