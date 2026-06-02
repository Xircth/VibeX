import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { PANEL_IDS } from '@/stores/useLayoutStore';

/**
 * Convenience hook that re-exports panel actions from context.
 *
 * Usage:
 * ```tsx
 * const { openFilePreview, openDiffPreview, toggleFileTree } = usePanelActions();
 * ```
 */
export function usePanelActions() {
  const {
    openFilePreview,
    openDiffPreview,
    openDiffPreviewAtPath,
    openNewTerminal,
    toggleEditorArea,
    splitActiveEditor,
    canSplitActiveEditor,
    closePanel,
    toggleFileTree,
    focusKanban,
    isPanelOpen,
  } = usePanelActionsContext();

  return {
    openFilePreview,
    openDiffPreview,
    openDiffPreviewAtPath,
    openNewTerminal,
    toggleEditorArea,
    splitActiveEditor,
    canSplitActiveEditor,
    closePanel,
    toggleFileTree,
    focusKanban,
    isPanelOpen,
    isTerminalOpen: isPanelOpen(PANEL_IDS.TERMINAL),
  };
}
