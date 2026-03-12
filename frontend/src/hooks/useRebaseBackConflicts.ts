import { useCallback, useMemo } from 'react';
import { buildResolveConflictsInstructions } from '@/lib/conflicts';
import type { RepoBranchStatus } from 'shared/types';

/**
 * Builds a conflict resolution prompt from branch status data
 * that can be sent to the AI via follow-up.
 *
 * This is specifically designed for rebase-back conflicts where
 * the AI branch changes were being merged into the target branch.
 */
export function useRebaseBackConflicts(
  branchStatus: RepoBranchStatus[] | undefined,
  workspaceBranch: string | null
) {
  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) =>
          r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );

  const hasConflicts = !!repoWithConflicts;

  const conflictPrompt = useMemo(() => {
    if (!repoWithConflicts?.conflicted_files?.length) return null;
    return buildResolveConflictsInstructions(
      workspaceBranch,
      repoWithConflicts.target_branch_name,
      repoWithConflicts.conflicted_files,
      repoWithConflicts.conflict_op ?? null,
      repoWithConflicts.repo_name
    );
  }, [workspaceBranch, repoWithConflicts]);

  const buildConflictFollowUp = useCallback(
    (additionalContext?: string): string | null => {
      if (!conflictPrompt) return null;
      const parts = [conflictPrompt];
      if (additionalContext?.trim()) {
        parts.push(additionalContext.trim());
      }
      return parts.join('\n\n');
    },
    [conflictPrompt]
  );

  return {
    hasConflicts,
    repoWithConflicts,
    conflictPrompt,
    buildConflictFollowUp,
  } as const;
}
