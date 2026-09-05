import {
  BOTTOM_PANEL_IDS,
  isEditorGroup,
  isPlaceholderPanelId,
  LEFT_PANEL_IDS,
  SESSION_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';

export function editorColumnShouldDismiss(
  editorGroups: ReadonlyArray<{ panels: ReadonlyArray<{ id: string }> }>
): boolean {
  if (editorGroups.length === 0) {
    return true;
  }
  return editorGroups.every((group) =>
    group.panels.every((panel) => isPlaceholderPanelId(panel.id))
  );
}

function isZonePanelId(panelId: string): boolean {
  return (
    LEFT_PANEL_IDS.has(panelId) ||
    SESSION_PANEL_IDS.has(panelId) ||
    BOTTOM_PANEL_IDS.has(panelId)
  );
}

/**
 * Closing the last real editor tab hides a welcome-only column. Switching the
 * activity-rail (or any other zone panel) must not, even if Welcome is the
 * only remaining editor tab.
 */
export function shouldDismissEditorColumnAfterPanelRemoval(
  removedPanel: {
    id: string;
    group?: { id: string; panels: ReadonlyArray<{ id: string }> };
  },
  editorGroups: ReadonlyArray<{ panels: ReadonlyArray<{ id: string }> }>
): boolean {
  if (isZonePanelId(removedPanel.id)) {
    return false;
  }
  if (removedPanel.group && !isEditorGroup(removedPanel.group)) {
    return false;
  }
  return editorColumnShouldDismiss(editorGroups);
}

export function collapsedEditorColumnWidths(input: {
  gridWidth: number;
  dockWidth: number;
  minDockWidth: number;
  minSessionWidth: number;
}): { dock: number; session: number } {
  const dock = Math.max(input.minDockWidth, Math.round(input.dockWidth));
  const session = Math.max(input.minSessionWidth, input.gridWidth - dock);
  return { dock, session };
}

/** Kept so Vite HMR can resolve modules still bound to the previous export name. */
export function lastPreviewTabWidths(input: {
  gridWidth: number;
  dockWidth: number;
  minDockWidth: number;
  minEditorWidth?: number;
  minSessionWidth: number;
}): { dock: number; editor: number; session: number } {
  const widths = collapsedEditorColumnWidths(input);
  return {
    dock: widths.dock,
    editor: 0,
    session: widths.session,
  };
}

export function editorColumnNeedsRestore(
  editorGroups: ReadonlyArray<{ panels: ReadonlyArray<{ id: string }> }>
): boolean {
  return editorColumnShouldDismiss(editorGroups);
}
