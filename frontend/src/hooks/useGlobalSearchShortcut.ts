import { useEffect } from 'react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

/**
 * Global keyboard shortcut for workspace search.
 *
 * Ctrl+Shift+F / Cmd+Shift+F -> open workspace search panel
 */
export function useGlobalSearchShortcut() {
  const { toggleSearchPanel, isPanelOpen } = usePanelActionsContext();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.altKey) return;

      if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (!isPanelOpen('search')) {
          toggleSearchPanel();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPanelOpen, toggleSearchPanel]);
}
