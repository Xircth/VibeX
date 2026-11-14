import { useLayoutEffect } from 'react';
import type { DockviewApi } from 'dockview-react';

export function useDockviewPanelActionsBinding(
  api: DockviewApi | null,
  setDockviewApi: (api: DockviewApi | null) => void
) {
  useLayoutEffect(() => {
    setDockviewApi(api);
    return () => setDockviewApi(null);
  }, [api, setDockviewApi]);
}
