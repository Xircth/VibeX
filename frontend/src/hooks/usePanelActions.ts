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
    closePanel,
    toggleFileTree,
    focusKanban,
    toggleCenter1Visibility,
    toggleCenter2Visibility,
    isCenter1Visible,
    isCenter2Visible,
  } = usePanelActionsContext();

  return {
    openFilePreview,
    openDiffPreview,
    openNewTerminal,
    closePanel,
    toggleFileTree,
    focusKanban,
    toggleCenter1Visibility,
    toggleCenter2Visibility,
    isCenter1Visible,
    isCenter2Visible,
  };
}
