import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, type RebaseResult } from '@/lib/api';

/**
 * Hook for the rebase-back operation: merging AI branch changes
 * back onto the target branch.
 *
 * This is the reverse of the normal rebase operation. Instead of
 * updating the AI branch with target branch changes, it pushes
 * the AI branch work into the target branch.
 */
export function useRebaseBack(
  workspaceId: string | undefined,
  onSuccess?: () => void,
  onError?: (err: RebaseResult) => void
) {
  const queryClient = useQueryClient();

  return useMutation<void, RebaseResult, { repoId: string }>({
    mutationFn: async ({ repoId }) => {
      if (!workspaceId) return;
      const res = await attemptsApi.rebaseBack(workspaceId, repoId);
      if (res.error) {
        return Promise.reject(res);
      }
    },
    onSuccess: () => {
      // Refresh branch status immediately
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitDiffs', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitLog', workspaceId],
      });
      onSuccess?.();
    },
    onError: (err: RebaseResult) => {
      // Even on failure (likely conflicts), re-fetch branch status
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitDiffs', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitLog', workspaceId],
      });
      onError?.(err);
    },
  });
}
