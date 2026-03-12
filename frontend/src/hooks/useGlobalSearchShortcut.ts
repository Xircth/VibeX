import { useEffect } from 'react';
import { useSearchStore } from '@/stores/useSearchStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

/**
 * Global keyboard shortcuts for search features.
 *
 * - Ctrl+P / Cmd+P → Open quick search palette
 * - Ctrl+Shift+F / Cmd+Shift+F → Toggle workspace search panel
 */
export function useGlobalSearchShortcut() {
  const openSearchPalette = useSearchStore((s) => s.openSearchPalette);
  const { toggleSearchPanel } = usePanelActionsContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const isMod = e.metaKey || e.ctrlKey;

      // Ctrl+P / Cmd+P → Quick search palette
      if (isMod && e.key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openSearchPalette();
        return;
      }

      // Ctrl+Shift+F / Cmd+Shift+F → Workspace text search panel
      if (isMod && e.shiftKey && e.key === 'F' && !e.altKey) {
        e.preventDefault();
        toggleSearchPanel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearchPalette, toggleSearchPanel]);
}
