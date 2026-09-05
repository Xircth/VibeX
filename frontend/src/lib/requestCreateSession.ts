import type { NavigateOptions, URLSearchParamsInit } from 'react-router-dom';
import type { KanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { useLayoutStore } from '@/stores/useLayoutStore';

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
  const layout = useLayoutStore.getState();
  layout.setRightPanelVisible(true);
  if (layout.activeTab === 'kanban') {
    layout.setKanbanSessionVisible(true);
  }

  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set('newSession', '1');
  setSearchParams(nextSearchParams, { replace: true });
}
