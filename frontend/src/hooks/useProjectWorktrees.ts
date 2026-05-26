import { useQuery } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';
import { dateTimestamp } from '@/utils/date';
import type { Workspace } from 'shared/types';

export const projectWorktreeKeys = {
  byProject: (projectId: string | undefined) =>
    ['projectWorktrees', projectId] as const,
};

export interface WorktreeInfo {
  workspace: Workspace;
}

/**
 * Returns all active (non-archived) workspaces for the current project.
 */
export function useProjectWorktrees(projectId: string | undefined) {
  const { data: projectWorkspaces, isLoading } = useQuery({
    queryKey: projectWorktreeKeys.byProject(projectId),
    queryFn: async () => {
      if (!projectId) return [];
      const workspaces = await attemptsApi.getProjectWorkspaces(projectId);
      return workspaces
        .filter((workspace) => !workspace.archived)
        .filter(
          (workspace, index, all) =>
            all.findIndex((candidate) => candidate.id === workspace.id) ===
            index
        )
        .sort(
          (left, right) =>
            dateTimestamp(right.updated_at) - dateTimestamp(left.updated_at)
        );
    },
    enabled: !!projectId,
  });

  const enriched: WorktreeInfo[] = (projectWorkspaces ?? []).map(
    (workspace) => ({
      workspace,
    })
  );

  return { worktrees: enriched, isLoading };
}
