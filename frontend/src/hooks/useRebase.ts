import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, type RebaseResult } from '@/lib/api';
import type { RebaseTaskAttemptRequest } from 'shared/types';
import { repoBranchKeys } from './useRepoBranches';

export function useRebase(
  attemptId: string | undefined,
  repoId: string | undefined,
  onSuccess?: () => void,
  onError?: (err: RebaseResult) => void
) {
  const queryClient = useQueryClient();

  type RebaseMutationArgs = {
    repoId: string;
    newBaseBranch?: string;
    oldBaseBranch?: string;
  };

  return useMutation<void, RebaseResult, RebaseMutationArgs>({
    mutationFn: (args) => {
      if (!attemptId) return Promise.resolve();
      const { repoId, newBaseBranch, oldBaseBranch } = args ?? {};

      const data: RebaseTaskAttemptRequest = {
        repo_id: repoId,
        old_base_branch: oldBaseBranch ?? null,
        new_base_branch: newBaseBranch ?? null,
      };

      return attemptsApi.rebase(attemptId, data).then((res) => {
        if (res.error) {
          return Promise.reject(res);
        }
      });
    },
    onSuccess: () => {
      // Refresh branch status immediately
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', attemptId],
      });

      // Invalidate taskAttempt query to refresh attempt.target_branch
      queryClient.invalidateQueries({
        queryKey: ['taskAttempt', attemptId],
      });

      // Refresh repos to update target_branch in RepoCard
      queryClient.invalidateQueries({
        queryKey: ['attemptRepo', attemptId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitDiffs', attemptId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitLog', attemptId],
      });

      // Refresh branch list
      if (repoId) {
        queryClient.invalidateQueries({
          queryKey: repoBranchKeys.byRepo(repoId),
        });
      }

      onSuccess?.();
    },
    onError: (err: RebaseResult) => {
      // Even on failure (likely conflicts), re-fetch branch status immediately to show rebase-in-progress
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', attemptId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitDiffs', attemptId],
      });
      queryClient.invalidateQueries({
        queryKey: ['gitLog', attemptId],
      });
      onError?.(err);
    },
  });
}
