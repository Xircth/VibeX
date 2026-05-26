import { useCallback, useMemo } from 'react';
import { useTauriPatchStream } from './useTauriPatchStream';
import type { Project } from 'shared/types';
import { dateTimestamp } from '@/utils/date';

type ProjectsState = {
  projects: Record<string, Project>;
};

export interface UseProjectsResult {
  projects: Project[];
  projectsById: Record<string, Project>;
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
}

export function useProjects(): UseProjectsResult {
  const initialData = useCallback((): ProjectsState => ({ projects: {} }), []);

  const { data, isConnected, isInitialized, error } =
    useTauriPatchStream<ProjectsState>({
      subscribeCommand: 'subscribe_projects_stream',
      eventChannel: 'projects-stream',
      initialData,
      enabled: true,
    });

  const projectsById = useMemo(() => data?.projects ?? {}, [data]);

  const projects = useMemo(() => {
    return Object.values(projectsById).sort(
      (a, b) => dateTimestamp(b.created_at) - dateTimestamp(a.created_at)
    );
  }, [projectsById]);

  const projectsData = data ? projects : undefined;
  const errorObj = useMemo(() => (error ? new Error(error) : null), [error]);

  return {
    projects: projectsData ?? [],
    projectsById,
    isLoading: !isInitialized && !error,
    isConnected,
    error: errorObj,
  };
}
