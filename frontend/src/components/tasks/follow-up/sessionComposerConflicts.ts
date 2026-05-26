import type { ConflictOp } from 'shared/types';
import { buildResolveConflictsInstructions } from '@/lib/conflicts';

type ComposerConflictRepo = {
  repo_name: string;
  target_branch_name: string | undefined;
  conflict_op: ConflictOp | null;
  is_rebase_in_progress: boolean;
  conflicted_files: string[];
};

export function getComposerRepoWithConflicts<
  T extends ComposerConflictRepo,
>(repos: readonly T[] | null | undefined): T | undefined {
  return repos?.find(
    (repo) =>
      repo.is_rebase_in_progress || (repo.conflicted_files?.length ?? 0) > 0
  );
}

export function buildComposerConflictInstructions({
  attemptBranch,
  repoWithConflicts,
}: {
  attemptBranch: string | null;
  repoWithConflicts: ComposerConflictRepo | null | undefined;
}): string | null {
  if (!repoWithConflicts?.conflicted_files?.length) return null;

  return buildResolveConflictsInstructions(
    attemptBranch,
    repoWithConflicts.target_branch_name,
    repoWithConflicts.conflicted_files,
    repoWithConflicts.conflict_op ?? null,
    repoWithConflicts.repo_name
  );
}

export function getConflictActionState({
  canSendFollowUp,
  isAttemptRunning,
  isEditable,
}: {
  canSendFollowUp: boolean;
  isAttemptRunning: boolean;
  isEditable: boolean;
}): {
  enableResolve: boolean;
  enableAbort: boolean;
} {
  const canAct = canSendFollowUp && !isAttemptRunning;
  return {
    enableResolve: canAct && isEditable,
    enableAbort: canAct,
  };
}
