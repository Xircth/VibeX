import type { NavigateOptions, URLSearchParamsInit } from 'react-router-dom';
import { useLayoutStore } from '@/stores/useLayoutStore';

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
