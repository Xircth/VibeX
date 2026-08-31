import { isPlaceholderPanelId } from '@/utils/dockviewGroupPolicy';

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
