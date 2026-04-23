import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { normalizeProjectRoute, paths } from '@/lib/paths';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

export function useProjectSwitcher() {
  const navigate = useNavigate();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const lastRouteByProject = useWindowProjectsStore(
    (state) => state.lastRouteByProject
  );

  return useCallback(
    (projectId: string, fallbackRoute?: string) => {
      ensureProjectOpen(projectId);
      navigate(
        normalizeProjectRoute(
          lastRouteByProject[projectId] ??
            fallbackRoute ??
            paths.projectSessions(projectId)
        )
      );
    },
    [ensureProjectOpen, lastRouteByProject, navigate]
  );
}
