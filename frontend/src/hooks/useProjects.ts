import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePatchStream } from './useTauriPatchStream';
import type { Project } from 'shared/types';
import { dateTimestamp } from '@/utils/date';
import { listedImportedProjects } from '@/lib/importedProject';
import { useBackendTransport } from '@/lib/transport';

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
  const transport = useBackendTransport();
  const remote = transport.environment !== 'desktop';
  const initialData = useCallback((): ProjectsState => ({ projects: {} }), []);

  const { data, isConnected, isInitialized, isRetrying, retryCount, error } =
    usePatchStream<ProjectsState>({
      subscribeCommand: 'subscribe_projects_stream',
      eventChannel: 'projects-stream',
      initialData,
      enabled: !remote,
    });
  const remoteProjects = useQuery({
    queryKey: ['projects', transport.environment],
    queryFn: async () => {
      const value = await transport.call('get_projects');
      return Array.isArray(value) ? (value as Project[]) : [];
    },
    enabled: remote,
  });

  const projectsById = useMemo(() => {
    const source = remote
      ? Object.fromEntries(
          (remoteProjects.data ?? []).map((project) => [project.id, project])
        )
      : (data?.projects ?? {});
    return Object.fromEntries(
      listedImportedProjects(Object.values(source)).map((project) => [
        project.id,
        project,
      ])
    );
  }, [data, remote, remoteProjects.data]);

  const projects = useMemo(() => {
    return Object.values(projectsById).sort(
      (a, b) => dateTimestamp(b.created_at) - dateTimestamp(a.created_at)
    );
  }, [projectsById]);

  const projectsData =
    (remote && remoteProjects.data !== undefined) || (!remote && data)
      ? projects
      : undefined;
  const waitingForInitialRetry =
    !isInitialized && isRetrying && retryCount <= 2;
  const errorObj = useMemo(
    () =>
      remote
        ? remoteProjects.error instanceof Error
          ? remoteProjects.error
          : null
        : error && !waitingForInitialRetry
          ? new Error(error)
          : null,
    [error, remote, remoteProjects.error, waitingForInitialRetry]
  );

  return {
    projects: projectsData ?? [],
    projectsById,
    isLoading: remote
      ? remoteProjects.isLoading
      : (!error || waitingForInitialRetry) &&
        (data === undefined || !isInitialized),
    isConnected: remote ? remoteProjects.isSuccess : isConnected,
    error: errorObj,
  };
}
