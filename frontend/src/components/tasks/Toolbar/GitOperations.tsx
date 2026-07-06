import {
  ArrowRight,
  GitBranch as GitBranchIcon,
  GitPullRequest,
  RefreshCw,
  Settings,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import type {
  RepoBranchStatus,
  Merge,
  TaskWithAttemptStatus,
  Workspace,
} from 'shared/types';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';
import RepoSelector from '@/components/tasks/RepoSelector';
import { RebaseDialog } from '@/components/dialogs/tasks/RebaseDialog';
import { CreatePRDialog } from '@/components/dialogs/tasks/CreatePRDialog';
import { GitConflictResolutionDialog } from '@/components/dialogs/tasks/GitConflictResolutionDialog';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useGitOperations } from '@/hooks/useGitOperations';
import { useRepoBranches } from '@/hooks';
import type { RebaseResult } from '@/lib/api';
import { useGitOperationsError } from '@/contexts/GitOperationsContext';

interface GitOperationsProps {
  selectedAttempt: Workspace;
  task: TaskWithAttemptStatus;
  branchStatus: RepoBranchStatus[] | null;
  branchStatusError?: Error | null;
  isAttemptRunning: boolean;
  selectedBranch: string | null;
  layout?: 'horizontal' | 'vertical';
}

export type GitOperationsInputs = Omit<GitOperationsProps, 'selectedAttempt'>;

function GitOperations({
  selectedAttempt,
  task,
  branchStatus,
  branchStatusError,
  isAttemptRunning,
  selectedBranch,
  layout = 'horizontal',
}: GitOperationsProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { repos, selectedRepoId, setSelectedRepoId } = useAttemptRepo(
    selectedAttempt.id
  );
  const git = useGitOperations(selectedAttempt.id, selectedRepoId ?? undefined);
  const { setError } = useGitOperationsError();
  const { data: branches = [] } = useRepoBranches(selectedRepoId);
  const isChangingTargetBranch = git.states.changeTargetBranchPending;

  // Local state for git operations
  const [merging, setMerging] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [rebasingBack, setRebasingBack] = useState(false);
  const [mergeSuccess, triggerMergeSuccess] = useTemporaryFlag(2000);
  const [pushSuccess, triggerPushSuccess] = useTemporaryFlag(2000);
  const [rebaseSuccess, triggerRebaseSuccess] = useTemporaryFlag(2000);
  const [rebaseBackSuccess, triggerRebaseBackSuccess] = useTemporaryFlag(2000);

  // Target branch change handlers
  const handleChangeTargetBranchClick = async (newBranch: string) => {
    const repoId = getSelectedRepoId();
    if (!repoId) return;
    await git.actions.changeTargetBranch({
      newTargetBranch: newBranch,
      repoId,
    });
  };

  const handleChangeTargetBranchDialogOpen = async () => {
    try {
      const result = await ChangeTargetBranchDialog.show({
        branches,
        isChangingTargetBranch: isChangingTargetBranch,
      });

      if (result.action === 'confirmed' && result.branchName) {
        await handleChangeTargetBranchClick(result.branchName);
      }
    } catch (error) {
      // Cancellation resolves as result.action !== 'confirmed', so a thrown
      // error here is a real failure — surface it instead of swallowing it.
      console.error('Change target branch failed:', error);
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const getSelectedRepoId = useCallback(() => {
    return selectedRepoId ?? repos[0]?.id;
  }, [selectedRepoId, repos]);

  const getSelectedRepoStatus = useCallback(() => {
    const repoId = getSelectedRepoId();
    return branchStatus?.find((r) => r.repo_id === repoId);
  }, [branchStatus, getSelectedRepoId]);

  // Memoize the selected repo status for use in button disabled states
  const selectedRepoStatus = useMemo(
    () => getSelectedRepoStatus(),
    [getSelectedRepoStatus]
  );
  const showConflictResolutionDialog = useCallback(
    async (result: RebaseResult) => {
      const error = result.error;
      if (error?.type !== 'merge_conflicts') {
        return false;
      }

      await GitConflictResolutionDialog.show({
        workspaceId: selectedAttempt.id,
        sourceBranch: selectedAttempt.branch,
        targetBranch:
          error.target_branch ??
          selectedRepoStatus?.target_branch_name ??
          'target branch',
        conflictedFiles: [...error.conflicted_files],
        op: error.op ?? null,
        repoName: selectedRepoStatus?.repo_name,
      });

      return true;
    },
    [
      selectedAttempt.id,
      selectedAttempt.branch,
      selectedRepoStatus?.repo_name,
      selectedRepoStatus?.target_branch_name,
    ]
  );

  const hasConflictsCalculated =
    (selectedRepoStatus?.conflicted_files?.length ?? 0) > 0;

  // Memoize merge status information to avoid repeated calculations
  const mergeInfo = useMemo(() => {
    const selectedRepoStatus = getSelectedRepoStatus();
    if (!selectedRepoStatus?.merges)
      return {
        hasOpenPR: false,
        openPR: null,
        hasMergedPR: false,
        mergedPR: null,
        hasMerged: false,
        latestMerge: null,
      };

    const openPR = selectedRepoStatus.merges.find(
      (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
    );

    const mergedPR = selectedRepoStatus.merges.find(
      (m: Merge) => m.type === 'pr' && m.pr_info.status === 'merged'
    );

    const merges = selectedRepoStatus.merges.filter(
      (m: Merge) =>
        m.type === 'direct' ||
        (m.type === 'pr' && m.pr_info.status === 'merged')
    );

    return {
      hasOpenPR: !!openPR,
      openPR,
      hasMergedPR: !!mergedPR,
      mergedPR,
      hasMerged: merges.length > 0,
      latestMerge: selectedRepoStatus.merges[0] || null, // Most recent merge
    };
  }, [getSelectedRepoStatus]);

  const mergeButtonLabel = useMemo(() => {
    if (mergeSuccess) return t('gitOperations.merged');
    if (merging) return t('gitOperations.merging');
    return t('gitOperations.merge');
  }, [mergeSuccess, merging, t]);

  const rebaseButtonLabel = useMemo(() => {
    if (rebaseSuccess) return t('gitOperations.rebased');
    if (rebasing) return t('gitOperations.rebasing');
    return t('gitOperations.rebase');
  }, [rebaseSuccess, rebasing, t]);

  const rebaseBackButtonLabel = useMemo(() => {
    if (rebaseBackSuccess) return t('gitOperations.rebasedBack');
    if (rebasingBack) return t('gitOperations.rebasingBack');
    return t('gitOperations.rebaseBack');
  }, [rebaseBackSuccess, rebasingBack, t]);

  const prButtonLabel = useMemo(() => {
    if (mergeInfo.hasOpenPR) {
      return pushSuccess
        ? t('gitOperations.pushed')
        : pushing
          ? t('gitOperations.pushing')
          : t('gitOperations.push');
    }
    return t('gitOperations.createPR');
  }, [mergeInfo.hasOpenPR, pushSuccess, pushing, t]);

  const handleMergeClick = async () => {
    // Directly perform merge without checking branch status
    await performMerge();
  };

  const handlePushClick = async () => {
    try {
      setPushing(true);
      const repoId = getSelectedRepoId();
      if (!repoId) return;
      await git.actions.push({ repo_id: repoId });
      triggerPushSuccess();
    } finally {
      setPushing(false);
    }
  };

  const performMerge = async () => {
    try {
      setMerging(true);
      const repoId = getSelectedRepoId();
      if (!repoId) return;
      await git.actions.merge({
        repoId,
      });
      triggerMergeSuccess();
    } finally {
      setMerging(false);
    }
  };

  const handleRebaseToTargetBranch = async (newBaseBranch: string) => {
    setRebasing(true);
    try {
      const repoId = getSelectedRepoId();
      if (!repoId) return;
      const currentTargetBranch =
        getSelectedRepoStatus()?.target_branch_name ?? null;
      await git.actions.rebase({
        repoId,
        newBaseBranch,
        oldBaseBranch:
          currentTargetBranch && currentTargetBranch !== newBaseBranch
            ? currentTargetBranch
            : undefined,
      });
      triggerRebaseSuccess();
    } catch (error) {
      await showConflictResolutionDialog(error as RebaseResult);
    } finally {
      setRebasing(false);
    }
  };

  const handleRebaseDialogOpen = async () => {
    if (!selectedAttempt.use_worktree) {
      setError(t('gitOperations.notInWorktree'));
      return;
    }

    try {
      const defaultTargetBranch = getSelectedRepoStatus()?.target_branch_name;
      const result = await RebaseDialog.show({
        branches,
        isRebasing: rebasing,
        initialTargetBranch: defaultTargetBranch,
        title: t('gitOperations.rebaseCurrentWorktreeTitle'),
        description: t('gitOperations.rebaseCurrentWorktreeDescription'),
        confirmLabel: t('gitOperations.rebase'),
      });
      if (result.action === 'confirmed' && result.branchName) {
        await handleRebaseToTargetBranch(result.branchName);
      }
    } catch (error) {
      // Cancellation resolves as result.action !== 'confirmed', so a thrown
      // error here is a real failure — surface it instead of swallowing it.
      console.error('Open rebase dialog failed:', error);
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRebaseBack = async () => {
    if (!selectedAttempt.use_worktree) {
      setError(t('gitOperations.notInWorktree'));
      return;
    }

    const defaultTargetBranch = getSelectedRepoStatus()?.target_branch_name;
    const result = await RebaseDialog.show({
      branches,
      isRebasing: rebasingBack,
      initialTargetBranch: defaultTargetBranch,
      title: t('gitOperations.rebaseBackTitle'),
      description: t('gitOperations.rebaseBackDescription'),
      confirmLabel: t('gitOperations.rebaseBack'),
    });

    if (result.action !== 'confirmed' || !result.branchName) {
      return;
    }

    setRebasingBack(true);
    try {
      const repoId = getSelectedRepoId();
      if (!repoId) return;
      const currentTargetBranch =
        getSelectedRepoStatus()?.target_branch_name ?? null;
      await git.actions.rebase({
        repoId,
        newBaseBranch: result.branchName,
        oldBaseBranch:
          currentTargetBranch && currentTargetBranch !== result.branchName
            ? currentTargetBranch
            : undefined,
      });
      await git.actions.rebaseBack({ repoId });
      triggerRebaseBackSuccess();
    } catch (error) {
      await showConflictResolutionDialog(error as RebaseResult);
    } finally {
      setRebasingBack(false);
    }
  };

  const handlePRButtonClick = async () => {
    // If PR already exists, push to it
    if (mergeInfo.hasOpenPR) {
      await handlePushClick();
      return;
    }

    CreatePRDialog.show({
      attempt: selectedAttempt,
      task,
      repoId: getSelectedRepoId(),
      targetBranch: getSelectedRepoStatus()?.target_branch_name,
    });
  };

  const isVertical = layout === 'vertical';

  const containerClasses = isVertical
    ? 'grid grid-cols-1 items-start gap-3 overflow-hidden'
    : 'flex items-center gap-2 overflow-hidden';

  const settingsBtnClasses = isVertical
    ? 'inline-flex h-5 w-5 p-0 hover:bg-muted'
    : 'hidden md:inline-flex h-5 w-5 p-0 hover:bg-muted';

  const actionsClasses = isVertical
    ? 'flex flex-wrap items-center gap-2'
    : 'shrink-0 flex flex-wrap items-center gap-2 overflow-y-hidden overflow-x-visible max-h-8';

  const statusChips = (
    <div className="flex items-center gap-2 text-xs min-w-0 overflow-hidden whitespace-nowrap">
      {(() => {
        const commitsAhead = selectedRepoStatus?.commits_ahead ?? 0;
        const commitsBehind = selectedRepoStatus?.commits_behind ?? 0;

        if (hasConflictsCalculated) {
          return (
            <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--warning)/0.12)] px-2 py-0.5 text-[hsl(var(--warning))]">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('gitOperations.conflict')}
            </span>
          );
        }

        if (selectedRepoStatus?.is_rebase_in_progress) {
          return (
            <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--warning)/0.12)] px-2 py-0.5 text-[hsl(var(--warning))]">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t('gitOperations.rebasing')}
            </span>
          );
        }

        if (mergeInfo.hasMergedPR) {
          return (
            <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--success)/0.12)] px-2 py-0.5 text-[hsl(var(--success))]">
              <CheckCircle className="h-3.5 w-3.5" />
              {t('gitOperations.merged')}
            </span>
          );
        }

        if (mergeInfo.hasOpenPR && mergeInfo.openPR?.type === 'pr') {
          const prMerge = mergeInfo.openPR;
          return (
            <button
              onClick={() => window.open(prMerge.pr_info.url, '_blank')}
              className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-full bg-[hsl(var(--info)/0.12)] px-2 py-0.5 text-[hsl(var(--info))] hover:underline sm:max-w-none"
              aria-label={t('gitOperations.openPR', {
                number: Number(prMerge.pr_info.number),
              })}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {`PR #${Number(prMerge.pr_info.number)}`}
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          );
        }

        const chips: React.ReactNode[] = [];
        if (commitsAhead > 0) {
          chips.push(
            <span
              key="ahead"
              className="hidden items-center gap-1 rounded-full bg-[hsl(var(--success)/0.12)] px-2 py-0.5 text-[hsl(var(--success))] sm:inline-flex"
            >
              {t('gitOperations.commitsAhead', { count: commitsAhead })}
            </span>
          );
        }
        if (commitsBehind > 0) {
          chips.push(
            <span
              key="behind"
              className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--warning)/0.12)] px-2 py-0.5 text-[hsl(var(--warning))]"
            >
              {t('gitOperations.commitsBehind', { count: commitsBehind })}
            </span>
          );
        }
        if (chips.length > 0)
          return <div className="flex items-center gap-2">{chips}</div>;

        return (
          <span className="text-muted-foreground hidden sm:inline">
            {t('gitOperations.upToDate')}
          </span>
        );
      })()}
    </div>
  );

  const branchChips = (
    <>
      {/* Task branch chip */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden sm:inline-flex items-center gap-1.5 max-w-[280px] px-2 py-0.5 rounded-full bg-muted text-xs font-medium min-w-0">
              <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="truncate">{selectedAttempt.branch}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('gitOperations.taskBranch')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <ArrowRight className="hidden sm:inline h-4 w-4 text-muted-foreground" />

      {/* Target branch chip + change button */}
      <div className="flex items-center gap-1 min-w-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 max-w-[280px] px-2 py-0.5 rounded-full bg-muted text-xs font-medium min-w-0">
                <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">
                  {getSelectedRepoStatus()?.target_branch_name ||
                    selectedBranch ||
                    t('gitOperations.current')}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
            {t('gitOperations.targetBranch')}
          </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleChangeTargetBranchDialogOpen}
                disabled={isAttemptRunning || hasConflictsCalculated}
                className={settingsBtnClasses}
                aria-label={t('gitOperations.changeTargetBranch')}
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('gitOperations.changeTargetBranch')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </>
  );

  return (
    <div className="w-full border-b py-2">
      <div className={containerClasses}>
        {isVertical ? (
          <>
            {repos.length > 1 && (
              <RepoSelector
                repos={repos}
                selectedRepoId={getSelectedRepoId() ?? null}
                onRepoSelect={setSelectedRepoId}
                disabled={isAttemptRunning}
                placeholder={t('gitOperations.selectRepo')}
              />
            )}
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {branchChips}
              {statusChips}
            </div>
          </>
        ) : (
          <>
            {repos.length > 0 && (
              <RepoSelector
                repos={repos}
                selectedRepoId={getSelectedRepoId() ?? null}
                onRepoSelect={setSelectedRepoId}
                disabled={isAttemptRunning}
                placeholder={t('gitOperations.selectRepo')}
                className="w-auto max-w-[200px] rounded-full bg-muted border-0 h-6 px-2 py-0.5 text-xs font-medium"
              />
            )}
            <div className="flex flex-1 items-center justify-center gap-2 min-w-0 overflow-hidden">
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                {branchChips}
              </div>
              {statusChips}
            </div>
          </>
        )}

        {/* Right: Actions */}
        {branchStatusError && !selectedRepoStatus ? (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{t('gitOperations.branchStatusUnavailable')}</span>
          </div>
        ) : selectedRepoStatus ? (
          <div className={actionsClasses}>
            <Button
              onClick={handleMergeClick}
              disabled={
                mergeInfo.hasMergedPR ||
                mergeInfo.hasOpenPR ||
                merging ||
                hasConflictsCalculated ||
                selectedRepoStatus?.is_target_remote ||
                ((selectedRepoStatus?.commits_ahead ?? 0) === 0 &&
                  !pushSuccess &&
                  !mergeSuccess)
              }
              variant="outline"
              size="xs"
              className="border-success text-success hover:bg-success gap-1 shrink-0"
              aria-label={mergeButtonLabel}
            >
              <GitBranchIcon className="h-3.5 w-3.5" />
              <span className="truncate max-w-[10ch]">{mergeButtonLabel}</span>
            </Button>

            <Button
              onClick={handlePRButtonClick}
              disabled={
                mergeInfo.hasMergedPR ||
                pushing ||
                hasConflictsCalculated ||
                (mergeInfo.hasOpenPR &&
                  (selectedRepoStatus?.remote_commits_ahead ?? 0) === 0) ||
                ((selectedRepoStatus?.commits_ahead ?? 0) === 0 &&
                  (selectedRepoStatus?.remote_commits_ahead ?? 0) === 0 &&
                  !pushSuccess &&
                  !mergeSuccess)
              }
              variant="outline"
              size="xs"
              className="border-info text-info hover:bg-info gap-1 shrink-0"
              aria-label={prButtonLabel}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              <span className="truncate max-w-[10ch]">{prButtonLabel}</span>
            </Button>

            <Button
              onClick={handleRebaseDialogOpen}
              disabled={rebasing || hasConflictsCalculated}
              variant="outline"
              size="xs"
              className={`gap-1 shrink-0 ${rebaseSuccess ? 'border-success text-success hover:bg-success' : 'border-warning text-warning hover:bg-warning'}`}
              aria-label={rebaseButtonLabel}
            >
              {rebaseSuccess ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <RefreshCw
                  className={`h-3.5 w-3.5 ${rebasing ? 'animate-spin' : ''}`}
                />
              )}
              <span className="truncate max-w-[10ch]">{rebaseButtonLabel}</span>
            </Button>

            <Button
              onClick={handleRebaseBack}
              disabled={rebasingBack || hasConflictsCalculated}
              variant="outline"
              size="xs"
              className={`gap-1 shrink-0 ${rebaseBackSuccess ? 'border-success text-success hover:bg-success' : 'border-warning text-warning hover:bg-warning'}`}
              aria-label={rebaseBackButtonLabel}
            >
              {rebaseBackSuccess ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <RefreshCw
                  className={`h-3.5 w-3.5 ${rebasingBack ? 'animate-spin' : ''}`}
                />
              )}
              <span className="truncate max-w-[10ch]">
                {rebaseBackButtonLabel}
              </span>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default GitOperations;
