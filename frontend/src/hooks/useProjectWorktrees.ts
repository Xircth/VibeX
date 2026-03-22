import { useQuery } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';
import type { Workspace, TaskWithAttemptStatus } from 'shared/types';
import { useProjectTasks } from './useProjectTasks';

export interface WorktreeInfo {
  workspace: Workspace;
  task: TaskWithAttemptStatus | null;
}

/**
 * Returns all active (non-archived) workspaces for the current project,
 * enriched with their parent task info.
 */
export function useProjectWorktrees(projectId: string | undefined) {
  const { tasksById } = useProjectTasks(projectId ?? '');

  const { data: projectWorkspaces, isLoading } = useQuery({
    queryKey: ['projectWorktrees', projectId],
    queryFn: async () => {
      if (!projectId) return [];
      const workspaces = await attemptsApi.getProjectWorkspaces(projectId);
      return workspaces
        .filter((workspace) => !workspace.archived)
        .filter(
          (workspace, index, all) =>
            all.findIndex((candidate) => candidate.id === workspace.id) === index
        )
        .sort(
          (left, right) =>
            new Date(right.updated_at).getTime() -
            new Date(left.updated_at).getTime()
        );
    },
    enabled: !!projectId,
  });

  const enriched: WorktreeInfo[] = (projectWorkspaces ?? []).map((ws) => ({
    workspace: ws,
    task: tasksById[ws.task_id] ?? null,
  }));

  return { worktrees: enriched, isLoading };
}
