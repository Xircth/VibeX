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
  const { tasks, tasksById } = useProjectTasks(projectId ?? '');

  // Collect all workspace IDs by iterating through tasks that have attempts
  const activeTaskIds = tasks
    .filter((t) => t.has_in_progress_attempt || t.status === 'inprogress' || t.status === 'inreview')
    .map((t) => t.id);

  const { data: worktrees, isLoading } = useQuery({
    queryKey: ['projectWorktrees', projectId, activeTaskIds],
    queryFn: async () => {
      if (!activeTaskIds.length) return [];
      const results = await Promise.all(
        activeTaskIds.map((taskId) => attemptsApi.getAll(taskId))
      );
      return results.flat().filter((w) => !w.archived);
    },
    enabled: !!projectId && activeTaskIds.length > 0,
  });

  const enriched: WorktreeInfo[] = (worktrees ?? []).map((ws) => ({
    workspace: ws,
    task: tasksById[ws.task_id] ?? null,
  }));

  return { worktrees: enriched, isLoading };
}
