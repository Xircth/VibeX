import { useCallback, useMemo } from 'react';
import type { Workspace, WorkspaceWithStatus } from 'shared/types';
import { useTauriPatchStream } from './useTauriPatchStream';
import { dateTimestamp } from '@/utils/date';

type ProjectWorkspacesState = {
  workspaces: Record<string, WorkspaceWithStatus>;
};

export interface UseProjectWorkspacesStreamResult {
  workspaces: Workspace[];
  workspacesWithStatus: WorkspaceWithStatus[];
  workspacesById: Record<string, Workspace>;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

export function useProjectWorkspacesStream(
  projectId: string
): UseProjectWorkspacesStreamResult {
  const subscribeArgs = useMemo(() => ({ projectId }), [projectId]);
  const initialData = useCallback(
    (): ProjectWorkspacesState => ({ workspaces: {} }),
    []
  );

  const { data, isConnected, isInitialized, error } =
    useTauriPatchStream<ProjectWorkspacesState>({
      subscribeCommand: 'subscribe_project_workspaces_stream',
      subscribeArgs,
      eventChannel: `project-workspaces-stream:${projectId}`,
      initialData,
      enabled: !!projectId,
    });

  const workspacesWithStatus = useMemo(
    () =>
      Object.values(data?.workspaces ?? {}).sort(
        (left, right) =>
          dateTimestamp(right.updated_at) - dateTimestamp(left.updated_at)
      ),
    [data?.workspaces]
  );

  const workspaces = useMemo(
    () =>
      workspacesWithStatus.map(
        ({ is_running: _isRunning, is_errored: _isErrored, ...workspace }) =>
          workspace
      ),
    [workspacesWithStatus]
  );

  const workspacesById = useMemo(
    () =>
      workspaces.reduce<Record<string, Workspace>>((accumulator, workspace) => {
        accumulator[workspace.id] = workspace;
        return accumulator;
      }, {}),
    [workspaces]
  );

  return {
    workspaces,
    workspacesWithStatus,
    workspacesById,
    isLoading: !isInitialized && !error,
    isConnected,
    error,
  };
}
