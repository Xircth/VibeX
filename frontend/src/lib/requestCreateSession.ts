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

export function requestCreateSessionInExecutionArea(
  setSearchParams: SearchParamsSetter,
  currentSearchParams: URLSearchParams
) {
  const canvasController = getCanvasWorkspaceController();
  if (canvasController?.createSession) {
    canvasController.createSession();
    return;
  }
  const layout = useLayoutStore.getState();
  layout.setRightPanelVisible(true);
  if (layout.activeTab === 'kanban') {
    layout.setKanbanSessionVisible(true);
  }

  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set('newSession', '1');
  setSearchParams(nextSearchParams, { replace: true });
}

export const CREATE_AGENT_SESSION_EVENT =
  'vibex:create-agent-session-in-execution-area';

export interface CreateAgentSessionEventDetail {
  agentId: string;
  targetGroupId?: string | null;
}

export function requestCreateAgentSessionInExecutionArea(
  agentId: string,
  targetGroupId?: string | null
) {
  const layout = useLayoutStore.getState();
  layout.setRightPanelVisible(true);
  if (layout.activeTab === 'kanban') {
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
