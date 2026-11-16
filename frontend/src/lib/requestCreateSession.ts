import type { NavigateOptions, URLSearchParamsInit } from 'react-router-dom';
import type { KanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { getCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';

export type CreateSessionSurface = 'execution-area' | 'beside-session-list';

export function resolveCreateSessionSurface(
  boardStyle: KanbanBoardStyle
): CreateSessionSurface {
  return boardStyle === 'canvas' ? 'beside-session-list' : 'execution-area';
}

type SearchParamsSetter = (
  nextInit: URLSearchParamsInit,
  navigateOpts?: NavigateOptions
) => void;

export const DISMISS_CREATE_SESSION_OVERLAY_EVENT =
  'dimo:dismiss-create-session-overlay';

export const DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT =
  'dimo:dismiss-collaboration-create-overlay';

export interface DismissCollaborationCreateOverlayDetail {
  exceptSource?: unknown;
}

export const REQUEST_CREATE_SESSION_OVERLAY_EVENT =
  'dimo:request-create-session-overlay';

export interface RequestCreateSessionOverlayEventDetail {
  targetGroupId?: string | null;
}

export function dismissCreateSessionOverlays() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DISMISS_CREATE_SESSION_OVERLAY_EVENT));
}

export function dismissCollaborationCreateOverlays(exceptSource?: unknown) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<DismissCollaborationCreateOverlayDetail>(
      DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
      { detail: { exceptSource } }
    )
  );
}

export function requestWorkspaceCreateSessionOverlay(
  targetGroupId?: string | null
) {
  dismissCollaborationCreateOverlays();

  const canvasController = getCanvasWorkspaceController();
  if (canvasController?.createSession) {
    canvasController.createSession();
    return;
  }

  const layout = useLayoutStore.getState();
  if (layout.activeTab === 'kanban') {
    layout.setRightPanelVisible(true);
    layout.setKanbanSessionVisible(true);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<RequestCreateSessionOverlayEventDetail>(
        REQUEST_CREATE_SESSION_OVERLAY_EVENT,
        {
          detail: { targetGroupId: targetGroupId ?? null },
        }
      )
    );
  }
}

export function requestCreateSessionInExecutionArea(
  setSearchParams: SearchParamsSetter,
  currentSearchParams: URLSearchParams
) {
  dismissCollaborationCreateOverlays();

  const canvasController = getCanvasWorkspaceController();
  if (canvasController?.createSession) {
    canvasController.createSession();
    return;
  }

  const layout = useLayoutStore.getState();
  if (layout.activeTab === 'kanban') {
    layout.setRightPanelVisible(true);
    layout.setKanbanSessionVisible(true);
  } else if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<RequestCreateSessionOverlayEventDetail>(
        REQUEST_CREATE_SESSION_OVERLAY_EVENT,
        {
          detail: { targetGroupId: null },
        }
      )
    );
  }

  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set('newSession', '1');
  setSearchParams(nextSearchParams, { replace: true });
}

export const CREATE_AGENT_SESSION_EVENT =
  'dimo:create-agent-session-in-execution-area';

export interface CreateAgentSessionEventDetail {
  agentId: string;
  targetGroupId?: string | null;
}

export function requestCreateAgentSessionInExecutionArea(
  agentId: string,
  targetGroupId?: string | null
) {
  dismissCollaborationCreateOverlays();

  const layout = useLayoutStore.getState();
  if (layout.activeTab === 'kanban') {
    layout.setRightPanelVisible(true);
    layout.setKanbanSessionVisible(true);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<CreateAgentSessionEventDetail>(
        CREATE_AGENT_SESSION_EVENT,
        {
          detail: { agentId, targetGroupId: targetGroupId ?? null },
        }
      )
    );
  }
}
