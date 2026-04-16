import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
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
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { useTask } from '@/hooks/useTask';
import { attemptsApi } from '@/lib/api';
import type { RebaseResult } from '@/lib/api';
import type { RepoBranchStatus, TaskWithAttemptStatus } from 'shared/types';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useChangeTargetBranch } from '@/hooks/useChangeTargetBranch';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';
import { GitConflictResolutionDialog } from '@/components/dialogs/tasks/GitConflictResolutionDialog';
import { GitActionsDialog } from '@/components/dialogs/tasks/GitActionsDialog';
import { RebaseDialog } from '@/components/dialogs/tasks/RebaseDialog';

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

function getRebaseOldBaseBranch(
  currentTargetBranch: string,
  nextTargetBranch: string
) {
  return currentTargetBranch !== nextTargetBranch ? currentTargetBranch : null;
}

export function BranchInfoHeader() {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const effectiveWorktreeId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? null;
  const { data: branchStatus } = useWorkspaceBranchStatus(
    effectiveWorktreeId ?? undefined
  );
  const { data: workspace } = useTaskAttempt(effectiveWorktreeId ?? undefined);
  const { data: task } = useTask(workspace?.task_id, {
    enabled: !!workspace?.task_id,
  });

  if (!effectiveWorktreeId || !branchStatus?.length) return null;

  const repo = branchStatus[0];
  const gitActionsTask: TaskWithAttemptStatus | undefined = task
    ? {
        ...task,
        has_in_progress_attempt:
          task.status === 'inprogress' || task.status === 'inreview',
        last_attempt_failed: false,
        executor: '',
      }
    : undefined;

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 text-muted-foreground">Base</span>
        <TargetBranchDropdown
          repo={repo}
          worktreeId={effectiveWorktreeId}
          useWorktree={Boolean(workspace?.use_worktree)}
        />
        <span className="shrink-0 text-muted-foreground">&rarr;</span>
        <span className="truncate font-mono text-foreground">HEAD</span>
        {(repo.commits_ahead ?? 0) > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-green-600">
            <ArrowUp className="h-2.5 w-2.5" />
            {repo.commits_ahead}
          </span>
        )}
        {(repo.commits_behind ?? 0) > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-orange-500">
            <ArrowDown className="h-2.5 w-2.5" />
            {repo.commits_behind}
          </span>
        )}
        {repo.is_rebase_in_progress && (
          <span className="flex shrink-0 items-center gap-0.5 text-destructive">
            <AlertTriangle className="h-2.5 w-2.5" />
            Rebase in progress
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <GitActionsButton
            worktreeId={effectiveWorktreeId}
            task={gitActionsTask}
          />
          <RebaseButton
            worktreeId={effectiveWorktreeId}
            repo={repo}
            useWorktree={Boolean(workspace?.use_worktree)}
          />
          <RebaseBackButton
            worktreeId={effectiveWorktreeId}
            repo={repo}
            useWorktree={Boolean(workspace?.use_worktree)}
          />
        </div>
      </div>
    </div>
  );
}

function GitActionsButton({
  worktreeId,
  task,
}: {
  worktreeId: string;
  task?: TaskWithAttemptStatus;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-5 px-1.5 text-[10px]"
      onClick={() => {
        if (!task) return;
        GitActionsDialog.show({
          attemptId: worktreeId,
          task,
        });
      }}
      disabled={!task}
    >
      Git Actions
    </Button>
  );
}

function TargetBranchDropdown({
  repo,
  worktreeId,
  useWorktree,
}: {
  repo: RepoBranchStatus;
  worktreeId: string;
  useWorktree: boolean;
}) {
  const { data: branches = [] } = useRepoBranches(repo.repo_id);
  const changeTargetBranch = useChangeTargetBranch(worktreeId, repo.repo_id);
  const isChangingTargetBranch = changeTargetBranch.isPending;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

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
      // Dialog was dismissed.
    }
  }, [branches, changeTargetBranch, isChangingTargetBranch, repo.repo_id]);

  const handleRebase = useCallback(async () => {
    if (!useWorktree) {
      setError('当前未处于 Worktree 中，请手动切换目标分支。');
      return;
    }

    setError(null);
    const result = await RebaseDialog.show({
      branches,
      initialTargetBranch: repo.target_branch_name,
      title: '变基当前 Worktree',
      description: '选择一个目标分支，将该分支的最新更改变基到当前 Worktree。',
      confirmLabel: '变基',
    });

    if (result.action !== 'confirmed' || !result.branchName) {
      return;
    }

    try {
      const rebaseResult = await attemptsApi.rebase(worktreeId, {
        repo_id: repo.repo_id,
        old_base_branch: getRebaseOldBaseBranch(
          repo.target_branch_name,
          result.branchName
        ),
        new_base_branch: result.branchName,
      });

      if (rebaseResult.error) {
        if (rebaseResult.error.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
          return;
        }
        await showConflictResolutionDialog(worktreeId, repo, rebaseResult);
        return;
      }

      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase failed.');
    }
  }, [branches, queryClient, repo, useWorktree, worktreeId]);

  return (
    <div className="flex flex-col items-start gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 font-mono text-foreground transition-colors hover:text-primary">
            <GitBranch className="h-3 w-3" />
            <span className="max-w-24 truncate">{repo.target_branch_name}</span>
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={handleChangeTarget}
            disabled={isChangingTargetBranch}
          >
            {isChangingTargetBranch
              ? 'Changing target branch...'
              : 'Change target branch...'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRebase}>Rebase</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}

function RebaseButton({
  worktreeId,
  repo,
  useWorktree,
}: {
  worktreeId: string;
  repo: RepoBranchStatus;
  useWorktree: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: branches = [] } = useRepoBranches(repo.repo_id);

  const handleRebase = useCallback(async () => {
    if (!useWorktree) {
      setError('当前未处于 Worktree 中，请手动切换目标分支。');
      return;
    }

    const result = await RebaseDialog.show({
      branches,
      isRebasing: loading,
      initialTargetBranch: repo.target_branch_name,
      title: '变基当前 Worktree',
      description: '选择一个目标分支，将该分支的最新更改变基到当前 Worktree。',
      confirmLabel: '变基',
    });

    if (result.action !== 'confirmed' || !result.branchName) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const rebaseResult = await attemptsApi.rebase(worktreeId, {
        repo_id: repo.repo_id,
        old_base_branch: getRebaseOldBaseBranch(
          repo.target_branch_name,
          result.branchName
        ),
        new_base_branch: result.branchName,
      });
      if (rebaseResult.error) {
        if (rebaseResult.error.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          await showConflictResolutionDialog(worktreeId, repo, rebaseResult);
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase failed.');
    } finally {
      setLoading(false);
    }
  }, [branches, loading, queryClient, repo, useWorktree, worktreeId]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-5 px-1.5 text-[10px]"
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
  useWorktree,
}: {
  worktreeId: string;
  repo: RepoBranchStatus;
  useWorktree: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: branches = [] } = useRepoBranches(repo.repo_id);

  const handleRebaseBack = useCallback(async () => {
    if (!useWorktree) {
      setError('当前未处于 Worktree 中，请手动切换目标分支。');
      return;
    }

    const result = await RebaseDialog.show({
      branches,
      isRebasing: loading,
      initialTargetBranch: repo.target_branch_name,
      title: '回基到目标分支',
      description:
        '选择一个目标分支。系统会先将该分支的最新更改变基到当前 Worktree，再把当前 Worktree 的更改合并回目标分支。',
      confirmLabel: '回基',
    });

    if (result.action !== 'confirmed' || !result.branchName) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const rebaseResult = await attemptsApi.rebase(worktreeId, {
        repo_id: repo.repo_id,
        old_base_branch: getRebaseOldBaseBranch(
          repo.target_branch_name,
          result.branchName
        ),
        new_base_branch: result.branchName,
      });

      if (rebaseResult.error) {
        const err = rebaseResult.error;
        if (err.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
          return;
        }
        await showConflictResolutionDialog(worktreeId, repo, rebaseResult);
        return;
      }

      const rebaseBackResult = await attemptsApi.rebaseBack(
        worktreeId,
        repo.repo_id
      );
      if (rebaseBackResult.error) {
        const err = rebaseBackResult.error;
        if (err.type === 'merge_conflicts') {
          await showConflictResolutionDialog(
            worktreeId,
            repo,
            rebaseBackResult
          );
        } else if (err.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          setError('Rebase failed.');
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch (caughtError) {
      try {
        const latestBranchStatus =
          await attemptsApi.getBranchStatus(worktreeId);
        const latestRepo = latestBranchStatus.find(
          (item) => item.repo_id === repo.repo_id
        );
        const conflictedFiles = latestRepo?.conflicted_files ?? [];

        if (latestRepo && conflictedFiles.length > 0) {
          await showConflictResolutionDialog(worktreeId, latestRepo, {
            error: {
              type: 'merge_conflicts',
              message: 'Merge conflicts detected while rebasing back.',
              op: latestRepo.conflict_op ?? 'merge',
              conflicted_files: [...conflictedFiles],
              target_branch: latestRepo.target_branch_name,
            },
          });
          queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
          return;
        }
      } catch (statusError) {
        console.error(
          'Failed to recover conflict details after rebase back failure:',
          statusError
        );
      }

      setError(
        caughtError instanceof Error && caughtError.message
          ? caughtError.message
          : 'Rebase back failed.'
      );
    } finally {
      setLoading(false);
    }
  }, [branches, loading, queryClient, repo, useWorktree, worktreeId]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-5 px-1.5 text-[10px]"
        onClick={handleRebaseBack}
        disabled={loading}
      >
        Rebase Back
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}
