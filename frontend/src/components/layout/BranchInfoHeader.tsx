import { useState, useCallback } from 'react';
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { attemptsApi } from '@/lib/api';
import type { RebaseResult } from '@/lib/api';
import type { RepoBranchStatus } from 'shared/types';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useChangeTargetBranch } from '@/hooks/useChangeTargetBranch';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';
import { GitConflictResolutionDialog } from '@/components/dialogs/tasks/GitConflictResolutionDialog';

async function showConflictResolutionDialog(
  worktreeId: string,
  repo: RepoBranchStatus,
  result: RebaseResult
) {
  const error = result.error;
  if (error?.type !== 'merge_conflicts') {
    return false;
  }

  await GitConflictResolutionDialog.show({
    workspaceId: worktreeId,
    sourceBranch: null,
    targetBranch: error.target_branch,
    conflictedFiles: [...error.conflicted_files],
    op: error.op ?? null,
    repoName: repo.repo_name,
  });

  return true;
}

export function BranchInfoHeader() {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const effectiveWorktreeId =
    activeWorktreeId ?? visibleRightSession?.workspaceId ?? null;
  const { data: branchStatus } = useWorkspaceBranchStatus(
    effectiveWorktreeId ?? undefined
  );

  if (!effectiveWorktreeId || !branchStatus?.length) return null;

  const repo = branchStatus[0];

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs min-w-0">
        <span className="text-muted-foreground shrink-0">鐩爣</span>
        <TargetBranchDropdown repo={repo} worktreeId={effectiveWorktreeId} />
        <span className="text-muted-foreground shrink-0">&rarr;</span>
        <span className="font-mono text-foreground truncate">HEAD</span>
        {(repo.commits_ahead ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-green-600 shrink-0">
            <ArrowUp className="h-2.5 w-2.5" />
            {repo.commits_ahead}
          </span>
        )}
        {(repo.commits_behind ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-orange-500 shrink-0">
            <ArrowDown className="h-2.5 w-2.5" />
            {repo.commits_behind}
          </span>
        )}
        {repo.is_rebase_in_progress && (
          <span className="flex items-center gap-0.5 text-destructive shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" />
            鍐茬獊
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <RebaseButton worktreeId={effectiveWorktreeId} repo={repo} />
          <RebaseBackButton worktreeId={effectiveWorktreeId} repo={repo} />
        </div>
      </div>
    </div>
  );
}

function TargetBranchDropdown({
  repo,
  worktreeId,
}: {
  repo: RepoBranchStatus;
  worktreeId: string;
}) {
  const { data: branches = [] } = useRepoBranches(repo.repo_id);
  const changeTargetBranch = useChangeTargetBranch(worktreeId, repo.repo_id);
  const isChangingTargetBranch = changeTargetBranch.isPending;

  const handleChangeTarget = useCallback(async () => {
    try {
      const result = await ChangeTargetBranchDialog.show({
        branches,
        isChangingTargetBranch,
      });
      if (result.action === 'confirmed' && result.branchName) {
        changeTargetBranch.mutate({
          newTargetBranch: result.branchName,
          repoId: repo.repo_id,
        });
      }
    } catch {
      // Dialog was dismissed
    }
  }, [branches, isChangingTargetBranch, changeTargetBranch, repo.repo_id]);

  const handleRebase = useCallback(async () => {
    const result = await attemptsApi.rebase(worktreeId, {
      repo_id: repo.repo_id,
      old_base_branch: null,
      new_base_branch: null,
    });
    await showConflictResolutionDialog(worktreeId, repo, result);
  }, [repo, worktreeId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 font-mono text-foreground hover:text-primary transition-colors">
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-24">{repo.target_branch_name}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={handleChangeTarget}
          disabled={isChangingTargetBranch}
        >
          {isChangingTargetBranch ? '鍒囨崲涓?..' : '鍒囨崲鐩爣鍒嗘敮'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRebase}>Rebase</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RebaseButton({
  worktreeId,
  repo,
}: {
  worktreeId: string;
  repo: RepoBranchStatus;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await attemptsApi.rebase(worktreeId, {
        repo_id: repo.repo_id,
        old_base_branch: null,
        new_base_branch: null,
      });
      if (result.error) {
        if (result.error.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          await showConflictResolutionDialog(worktreeId, repo, result);
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase failed.');
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repo, queryClient]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-5 text-[10px] px-1.5"
        onClick={handleRebase}
        disabled={loading}
      >
        Rebase
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}

function RebaseBackButton({
  worktreeId,
  repo,
}: {
  worktreeId: string;
  repo: RepoBranchStatus;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebaseBack = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await attemptsApi.rebaseBack(worktreeId, repo.repo_id);
      if (result.error) {
        const err = result.error;
        if (err.type === 'merge_conflicts') {
          await showConflictResolutionDialog(worktreeId, repo, result);
        } else if (err.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          setError('Rebase failed.');
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase back failed.');
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repo, queryClient]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-5 text-[10px] px-1.5"
        onClick={handleRebaseBack}
        disabled={loading}
      >
        Rebase Back
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}
