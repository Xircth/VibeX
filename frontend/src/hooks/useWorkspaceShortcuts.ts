import { useEffect } from 'react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { settingsWindowApi } from '@/lib/api';
import { PANEL_IDS } from '@/stores/useLayoutStore';

function isModifierShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function useWorkspaceShortcuts() {
  const {
    openOrFocusPanel,
    toggleFileTree,
    toggleSearchPanel,
    isPanelOpen,
  } = usePanelActionsContext();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.defaultPrevented ||
        !isModifierShortcut(event)
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      if (event.shiftKey && key === 'f') {
        event.preventDefault();
        if (!isPanelOpen(PANEL_IDS.SEARCH)) {
          toggleSearchPanel();
        }
        return;
      }

      if (!event.shiftKey && key === 'p') {
        event.preventDefault();
        toggleFileTree();
        return;
      }

      if (
        !event.shiftKey &&
        (event.key === '`' || event.code === 'Backquote')
      ) {
        event.preventDefault();
        openOrFocusPanel(PANEL_IDS.TERMINAL, 'Terminal');
        return;
      }

      if (!event.shiftKey && event.key === ',') {
        event.preventDefault();
        void settingsWindowApi.open();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPanelOpen, openOrFocusPanel, toggleFileTree, toggleSearchPanel]);
}
