import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { paths } from '@/lib/paths';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

export interface ProjectSessionTarget {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

/**
 * Navigate to a specific session anywhere in the app: opens the project,
 * focuses it in the rail, switches to the kanban tab and routes to the
 * session. Same behavior as clicking a session in the project rail popover.
 */
export function useOpenProjectSession() {
  const navigate = useNavigate();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const requestProjectFocus = useWindowProjectsStore(
    (state) => state.requestProjectFocus
  );
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const setProjectActiveTab = useLayoutStore(
    (state) => state.setProjectActiveTab
  );

  return useCallback(
    ({ projectId, workspaceId, sessionId }: ProjectSessionTarget) => {
      setRailVisible(true);
      ensureProjectOpen(projectId);
      requestProjectFocus(projectId, {
        workspaceId,
        sessionId,
        requestedAt: Date.now(),
      });
      setProjectActiveTab(projectId, 'kanban');
      navigate(paths.projectSession(projectId, workspaceId, sessionId));
    },
    [
      ensureProjectOpen,
      navigate,
      requestProjectFocus,
      setProjectActiveTab,
      setRailVisible,
    ]
  );
}
