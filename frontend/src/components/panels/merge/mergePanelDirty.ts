const dirtyPanels = new Set<string>();

export function setMergePanelDirty(panelId: string, dirty: boolean) {
  if (dirty) dirtyPanels.add(panelId);
  else dirtyPanels.delete(panelId);
}

export function isMergePanelDirty(panelId: string): boolean {
  return dirtyPanels.has(panelId);
}

export function confirmDiscardMergePanel(panelId: string): boolean {
  if (!isMergePanelDirty(panelId)) return true;
  return window.confirm('Discard unsaved conflict resolution?');
}
