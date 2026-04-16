import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { paths } from '@/lib/paths';
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
        lastRouteByProject[projectId] ??
          fallbackRoute ??
          paths.projectTasks(projectId)
      );
    },
    [ensureProjectOpen, lastRouteByProject, navigate]
  );
}
