import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import LiquidGlass from 'liquid-glass-react';
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
import { useMediaQuery } from '@/hooks/useMediaQuery';

const STATIC_GLASS_POINTER = { x: 0, y: 0 };

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
  const glassStageRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
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
    <div className="branch-info-header-host">
      <div ref={glassStageRef} className="branch-info-glass-stage">
        <LiquidGlass
          className="branch-info-liquid-glass"
          padding="0"
          cornerRadius={12}
          displacementScale={72}
          blurAmount={0.04}
          saturation={140}
          aberrationIntensity={2}
          elasticity={prefersReducedMotion ? 0 : 0.12}
          mouseContainer={glassStageRef}
          globalMousePos={
            prefersReducedMotion ? STATIC_GLASS_POINTER : undefined
          }
          mouseOffset={prefersReducedMotion ? STATIC_GLASS_POINTER : undefined}
          mode="prominent"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: '100%',
            height: '100%',
          }}
        >
          <div
            className="branch-info-toolbar"
            role="toolbar"
            aria-label="Git workspace controls"
          >
            <div className="branch-info-summary">
              <span className="branch-info-context-label">目标</span>
              <TargetBranchDropdown
                repo={repo}
                worktreeId={effectiveWorktreeId}
                useWorktree={Boolean(workspace?.use_worktree)}
              />
              <span className="branch-info-direction" aria-hidden="true">
                &rarr;
              </span>
              <span className="branch-info-context-label">当前</span>
              <span
                className="branch-info-current-branch"
                title={workspace?.branch}
              >
                {workspace?.branch ?? 'HEAD'}
              </span>
              {(repo.commits_ahead ?? 0) > 0 && (
                <span className="branch-info-ahead">
                  <ArrowUp className="h-3 w-3" aria-hidden="true" />
                  {repo.commits_ahead}
                </span>
              )}
              {(repo.commits_behind ?? 0) > 0 && (
                <span className="branch-info-behind">
                  <ArrowDown className="h-3 w-3" aria-hidden="true" />
                  {repo.commits_behind}
                </span>
              )}
              {repo.is_rebase_in_progress && (
                <span className="branch-info-rebase-status">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Rebase in progress
                </span>
              )}
            </div>
            <div className="branch-info-actions">
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
        </LiquidGlass>
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
      variant="ghost"
      size="sm"
      className="branch-info-action branch-info-action-primary"
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
  const { t } = useTranslation(['panels', 'common']);
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
      setError(t('branchInfo.notInWorktree'));
      return;
    }

    setError(null);
    const result = await RebaseDialog.show({
      branches,
      initialTargetBranch: repo.target_branch_name,
      title: t('branchInfo.rebaseDialogTitle'),
      description: t('branchInfo.rebaseDialogDescription'),
      confirmLabel: t('branchInfo.rebaseConfirmLabel'),
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
  }, [branches, queryClient, repo, t, useWorktree, worktreeId]);

  return (
    <div className="branch-info-control-stack">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="branch-info-branch-button">
            <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="max-w-28 truncate">{repo.target_branch_name}</span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
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
      {error && (
        <span className="branch-info-error" role="status">
          {error}
        </span>
      )}
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
  const { t } = useTranslation(['panels', 'common']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: branches = [] } = useRepoBranches(repo.repo_id);

  const handleRebase = useCallback(async () => {
    if (!useWorktree) {
      setError(t('branchInfo.notInWorktree'));
      return;
    }

    const result = await RebaseDialog.show({
      branches,
      isRebasing: loading,
      initialTargetBranch: repo.target_branch_name,
      title: t('branchInfo.rebaseDialogTitle'),
      description: t('branchInfo.rebaseDialogDescription'),
      confirmLabel: t('branchInfo.rebaseConfirmLabel'),
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
  }, [branches, loading, queryClient, repo, t, useWorktree, worktreeId]);

  return (
    <div className="branch-info-control-stack">
      <Button
        variant="ghost"
        size="sm"
        className="branch-info-action"
        onClick={handleRebase}
        disabled={loading}
      >
        Rebase
      </Button>
      {error && (
        <span className="branch-info-error" role="status">
          {error}
        </span>
      )}
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
  const { t } = useTranslation(['panels', 'common']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: branches = [] } = useRepoBranches(repo.repo_id);

  const handleRebaseBack = useCallback(async () => {
    if (!useWorktree) {
      setError(t('branchInfo.notInWorktree'));
      return;
    }

    const result = await RebaseDialog.show({
      branches,
      isRebasing: loading,
      initialTargetBranch: repo.target_branch_name,
      title: t('branchInfo.rebaseBackDialogTitle'),
      description: t('branchInfo.rebaseBackDialogDescription'),
      confirmLabel: t('branchInfo.rebaseBackConfirmLabel'),
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
  }, [branches, loading, queryClient, repo, t, useWorktree, worktreeId]);

  return (
    <div className="branch-info-control-stack">
      <Button
        variant="ghost"
        size="sm"
        className="branch-info-action"
        onClick={handleRebaseBack}
        disabled={loading}
      >
        Rebase Back
      </Button>
      {error && (
        <span className="branch-info-error" role="status">
          {error}
        </span>
      )}
    </div>
  );
}
