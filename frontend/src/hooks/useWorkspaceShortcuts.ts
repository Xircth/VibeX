import { useEffect } from 'react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { settingsWindowApi } from '@/lib/api';
import { PANEL_IDS, useLayoutStore } from '@/stores/useLayoutStore';
import {
  SHORTCUT_ACTION_EVENT,
  type ShortcutActionEventDetail,
} from '@/keyboard';

function isModifierShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function useWorkspaceShortcuts() {
  const {
    openOrFocusPanel,
    openDiffPreview,
    openLogs,
    toggleFileTree,
    toggleSearchPanel,
    isPanelOpen,
  } = usePanelActionsContext();
  const toggleRightPanel = useLayoutStore((state) => state.toggleRightPanel);

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

  useEffect(() => {
    const handleShortcutAction = (event: Event) => {
      const { actionId } = (event as CustomEvent<ShortcutActionEventDetail>)
        .detail;
      switch (actionId) {
        case 'toggle-changes-mode':
          openDiffPreview();
          break;
        case 'toggle-logs-mode':
          openLogs();
          break;
        case 'toggle-preview-mode':
          openOrFocusPanel(PANEL_IDS.PREVIEW, 'Preview');
          break;
        case 'toggle-left-sidebar':
          toggleFileTree();
          break;
        case 'toggle-left-main-panel':
          toggleRightPanel();
          break;
        default:
          break;
      }
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
    return () =>
      window.removeEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
  }, [
    openDiffPreview,
    openLogs,
    openOrFocusPanel,
    toggleFileTree,
    toggleRightPanel,
  ]);
}
