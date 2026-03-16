import { useRebase } from './useRebase';
import { useRebaseBack } from './useRebaseBack';
import { useMerge } from './useMerge';
import { usePush } from './usePush';
import { useChangeTargetBranch } from './useChangeTargetBranch';
import { useGitOperationsError } from '@/contexts/GitOperationsContext';
import type { RebaseResult } from '@/lib/api';
import type { PushTaskAttemptRequest } from 'shared/types';
import { ForcePushDialog } from '@/components/dialogs/git/ForcePushDialog';

export function useGitOperations(
  attemptId: string | undefined,
  repoId: string | undefined
) {
  const { setError } = useGitOperationsError();

  const rebase = useRebase(
    attemptId,
    repoId,
    () => setError(null),
    (err: RebaseResult) => {
      const data = err?.error;
      const isConflict =
        data?.type === 'merge_conflicts' ||
        data?.type === 'rebase_in_progress';
      if (!isConflict) {
        setError('Failed to rebase');
      }
    }
  );

  const merge = useMerge(
    attemptId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to merge';
      setError(message);
    }
  );

  const forcePush = usePush(
    attemptId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to force push';
      setError(message);
    },
    { force: true }
  );

  const push = usePush(
    attemptId,
    () => setError(null),
    async (err: unknown, errorData, params?: PushTaskAttemptRequest) => {
      // Handle typed push errors
      if (errorData?.type === 'force_push_required') {
        // Show confirmation dialog - dialog handles the force push internally
        if (attemptId && params?.repo_id) {
          await ForcePushDialog.show({ attemptId, repoId: params.repo_id });
        }
        return;
      }

      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to push';
      setError(message);
    }
  );

  const rebaseBack = useRebaseBack(
    attemptId,
    () => setError(null),
    (err: RebaseResult) => {
      const data = err?.error;
      const isConflict =
        data?.type === 'merge_conflicts' ||
        data?.type === 'rebase_in_progress';
      if (!isConflict) {
        setError('Failed to rebase back');
      }
    }
  );

  const changeTargetBranch = useChangeTargetBranch(
    attemptId,
    repoId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to change target branch';
      setError(message);
    }
  );

  const isAnyLoading =
    rebase.isPending ||
    rebaseBack.isPending ||
    merge.isPending ||
    push.isPending ||
    forcePush.isPending ||
    changeTargetBranch.isPending;

  return {
    actions: {
      rebase: rebase.mutateAsync,
      rebaseBack: rebaseBack.mutateAsync,
      merge: merge.mutateAsync,
      push: push.mutateAsync,
      forcePush: forcePush.mutateAsync,
      changeTargetBranch: changeTargetBranch.mutateAsync,
    },
    isAnyLoading,
    states: {
      rebasePending: rebase.isPending,
      rebaseBackPending: rebaseBack.isPending,
      mergePending: merge.isPending,
      pushPending: push.isPending,
      forcePushPending: forcePush.isPending,
      changeTargetBranchPending: changeTargetBranch.isPending,
    },
  };
}
