import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, Result } from '@/lib/api';
import type { GitOperationError } from 'shared/types';

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
  onError?: (err: Result<void, GitOperationError>) => void
) {
  const queryClient = useQueryClient();

  return useMutation<void, Result<void, GitOperationError>, { repoId: string }>(
    {
      mutationFn: async ({ repoId }) => {
        if (!workspaceId) return;
        const res = await attemptsApi.rebaseBack(workspaceId, repoId);
        if (!res.success) {
          return Promise.reject(res);
        }
      },
      onSuccess: () => {
        // Refresh branch status immediately
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        onSuccess?.();
      },
      onError: (err: Result<void, GitOperationError>) => {
        // Even on failure (likely conflicts), re-fetch branch status
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        onError?.(err);
      },
    }
  );
}
