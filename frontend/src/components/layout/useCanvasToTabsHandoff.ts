import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  flushCanvasDocumentPersist,
  getActiveCanvasEntry,
  loadCanvasWorkspace,
} from '@/components/kanban/canvas/canvasStorage';
import { getCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  getWorkspaceStageStyle,
  useWorkspaceStageStyle,
} from '@/lib/workspaceStageStyle';
import {
  planCanvasTabsFromNodes,
  type CanvasSessionTabMeta,
  type CanvasTabOpenRequest,
} from './canvasToTabs';

function readCachedSessionTabs(
  queryClient: ReturnType<typeof useQueryClient>
): Map<string, CanvasSessionTabMeta> {
  const map = new Map<string, CanvasSessionTabMeta>();
  const queries = queryClient.getQueriesData<unknown>({
    queryKey: ['workspaceSessions'],
  });
  for (const [queryKey, data] of queries) {
    if (!Array.isArray(data)) continue;
    const keyWorkspaceId = typeof queryKey[1] === 'string' ? queryKey[1] : '';
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      if (!id) continue;
      const workspaceId =
        typeof record.workspace_id === 'string' &&
        record.workspace_id.length > 0
          ? record.workspace_id
          : keyWorkspaceId;
      if (!workspaceId) continue;
      const parsedUpdatedAt =
        typeof record.updated_at === 'string'
          ? Date.parse(record.updated_at)
          : 0;
      const updatedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0;
      const previous = map.get(id);
      if (previous && previous.updatedAt >= updatedAt) continue;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const displayName =
        typeof record.display_name === 'string'
          ? record.display_name.trim()
          : '';
      map.set(id, {
        workspaceId,
        updatedAt,
        title: name || displayName || null,
        agentId: typeof record.agent_id === 'string' ? record.agent_id : null,
      });
    }
  }
  return map;
}

function openCanvasTabRequest(
  request: CanvasTabOpenRequest,
  actions: {
    openSessionTab: (options: {
      sessionId: string;
      workspaceId: string;
      title?: string | null;
      agentId?: string | null;
      activate?: boolean;
    }) => void;
    openOrFocusPanel: (
      panelId: string,
      title: string,
      params?: Record<string, unknown>
    ) => void;
  }
) {
  if (request.kind === 'session') {
    actions.openSessionTab({
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      title: request.title,
      agentId: request.agentId,
      activate: request.activate,
    });
    return;
  }
  actions.openOrFocusPanel(request.panelId, request.title, request.params);
}

/**
 * When the workspace leaves infinite canvas for free tabs, open the most
 * recently active canvas nodes as tabs. Capped so a crowded board cannot
 * flood the tab bar.
 */
export function useCanvasToTabsHandoff(projectId: string | undefined) {
  const style = useWorkspaceStageStyle();
  const previousStyleRef = useRef(style);
  const queryClient = useQueryClient();
  const { openSessionTab, openOrFocusPanel } = usePanelActionsContext();

  useEffect(() => {
    const previous = previousStyleRef.current;
    previousStyleRef.current = style;
    if (previous !== 'canvas' || style !== 'tabs' || !projectId) return;

    flushCanvasDocumentPersist();
    const document = getActiveCanvasEntry(
      loadCanvasWorkspace(projectId)
    ).document;
    const requests = planCanvasTabsFromNodes(
      document.nodes,
      readCachedSessionTabs(queryClient),
      { now: Date.now() }
    );
    if (requests.length === 0) return;

    const actions = { openSessionTab, openOrFocusPanel };
    let attempts = 0;
    let frame = 0;
    let cancelled = false;
    const openWhenCanvasReleased = () => {
      if (cancelled || getWorkspaceStageStyle() !== 'tabs') return;
      if (getCanvasWorkspaceController() && attempts < 5) {
        attempts += 1;
        frame = window.requestAnimationFrame(openWhenCanvasReleased);
        return;
      }
      if (getCanvasWorkspaceController()) return;
      for (const request of requests) {
        openCanvasTabRequest(request, actions);
      }
    };
    openWhenCanvasReleased();
    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [openOrFocusPanel, openSessionTab, projectId, queryClient, style]);
}
