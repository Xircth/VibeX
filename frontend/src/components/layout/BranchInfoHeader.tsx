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
import { HostGlass } from '@/components/ui/host-glass';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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

  if (
    !effectiveWorktreeId ||
    !branchStatus?.length ||
    !workspace?.use_worktree
  ) {
    return null;
  }

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
        <HostGlass
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
          <TooltipProvider delayDuration={120}>
            <div
              className="branch-info-toolbar"
              role="toolbar"
              aria-label="Git workspace controls"
            >
              <div className="branch-info-summary">
                <TargetBranchDropdown
                  repo={repo}
                  worktreeId={effectiveWorktreeId}
                  useWorktree
                />
                <span className="branch-info-direction" aria-hidden="true">
                  –
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="branch-info-current-branch"
                      tabIndex={0}
                      aria-label={`当前分支：${workspace?.branch ?? 'HEAD'}`}
                    >
                      {workspace?.branch ?? 'HEAD'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    当前分支：{workspace?.branch ?? 'HEAD'}
                  </TooltipContent>
                </Tooltip>
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
              </div>
            </div>
          </TooltipProvider>
        </HostGlass>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                className="branch-info-branch-button"
                aria-label={`目标分支：${repo.target_branch_name}`}
              >
                <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="max-w-28 truncate">
                  {repo.target_branch_name}
                </span>
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            目标分支：{repo.target_branch_name}
          </TooltipContent>
        </Tooltip>
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
