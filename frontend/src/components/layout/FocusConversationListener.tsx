import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { backendListen } from '@/lib/backendTransport';
import {
  focusEventMatchesWindow,
  focusWorkspaceConversation,
  parseFocusConversationPayload,
} from '@/lib/focusConversation';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useUiPreferencesStore } from '@/stores/useUiPreferencesStore';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

export function FocusConversationListener() {
  const navigate = useNavigate();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      let windowLabel = '';
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        windowLabel = getCurrentWindow().label.trim();
      } catch {
        windowLabel = '';
      }
      if (cancelled || !windowLabel) return;
      const stop = await backendListen<unknown>(
        'workspace-focus-conversation',
        (payload) => {
          if (!focusEventMatchesWindow(payload, windowLabel)) return;
          const target = parseFocusConversationPayload(payload);
          if (!target) return;
          const focused = focusWorkspaceConversation({
            projectId: target.projectId,
            workspaceId: target.workspaceId,
            conversationId: target.conversationId,
            existingPanelId: target.panelId,
          });
          useUiPreferencesStore.getState().setLayoutMode('workspaces');
          useLayoutStore.getState().setActiveTab('workspace');
          useWindowProjectsStore
            .getState()
            .ensureProjectOpen(target.projectId);
          navigate(focused.path);
        }
      );
      if (cancelled) stop();
      else unlisten = stop;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);

  return null;
}
