import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

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
    openNewTerminal,
    splitActiveEditor,
    canSplitActiveEditor,
    closePanel,
    toggleFileTree,
    focusKanban,
  } = usePanelActionsContext();

  return {
    openFilePreview,
    openDiffPreview,
    openNewTerminal,
    splitActiveEditor,
    canSplitActiveEditor,
    closePanel,
    toggleFileTree,
    focusKanban,
  };
}
