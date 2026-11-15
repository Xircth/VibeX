import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  GitBranch,
  Shield,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { useTask } from '@/hooks/useTask';
import { attemptsApi } from '@/lib/api';
import type { RebaseResult } from '@/lib/api';
import {
  pulseApi,
  type PulseRuleSpec,
  type PulseRuleView,
  type PulseSubscriptionView,
} from '@/lib/api/pulse';
import type { RepoBranchStatus, TaskWithAttemptStatus } from 'shared/types';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useChangeTargetBranch } from '@/hooks/useChangeTargetBranch';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';
import { GitConflictResolutionDialog } from '@/components/dialogs/tasks/GitConflictResolutionDialog';
import { GitActionsDialog } from '@/components/dialogs/tasks/GitActionsDialog';
import { RebaseDialog } from '@/components/dialogs/tasks/RebaseDialog';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import i18n from '@/i18n';

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

export function BranchInfoHeader({
  workspaceId: propWorkspaceId,
}: {
  workspaceId?: string | null;
} = {}) {
  const glassStageRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const worktree = useOptionalWorktree();
  const kanbanSession = useOptionalKanbanSessionContext();
  const effectiveWorktreeId =
    propWorkspaceId ??
    worktree?.activeWorktreeId ??
    kanbanSession?.visibleRightSession?.workspaceId ??
    null;
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
              aria-label={i18n.t('panels:ui.branch.gitWorkspaceControls')}
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
                      aria-label={i18n.t(
                        'panels:ui.branch.currentBranchBranch',
                        { branch: workspace?.branch ?? 'HEAD' }
                      )}
                    >
                      {workspace?.branch ?? 'HEAD'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {i18n.t('panels:ui.branch.currentBranchLabel', {
                      branch: workspace?.branch ?? 'HEAD',
                    })}
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
                    {i18n.t('panels:ui.branch.rebaseInProgress')}
                  </span>
                )}
              </div>
              <div className="branch-info-actions">
                <PulseGuardMenu
                  repoName={repo.repo_name}
                  branchName={workspace?.branch ?? 'HEAD'}
                  worktreeId={effectiveWorktreeId}
                />
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

function buildCiGuardSpec(
  repoName: string,
  branchName: string,
  worktreeId: string
): PulseRuleSpec {
  return {
    name: `CI Guard: ${repoName}@${branchName}`,
    description: `Auto-diagnose CI failures on ${branchName}`,
    workspaceId: worktreeId,
    evalMode: 'auto',
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: ['github'],
      sourceInstanceIds: [],
      eventTypes: ['github.workflow_run.failed', 'github.check_suite.failed'],
      allowedActors: [],
      conditions: [
        { op: 'not_bot_actor' },
        { op: 'eq', pointer: '/branch', value: branchName },
      ],
    },
    temporal: null,
    targets: [
      {
        kind: 'session',
        mode: 'ephemeral_fresh',
        agentId: 'CLAUDE_CODE',
        workspaceIsolation: 'isolated_worktree',
        subscribeThread: true,
        promptTemplate: `Diagnose CI failure on ${repoName}@${branchName}: {{payload.summary}}`,
      },
    ],
  };
}

function buildPrReviewGuardSpec(
  repoName: string,
  branchName: string,
  worktreeId: string
): PulseRuleSpec {
  return {
    name: `PR Review Guard: ${repoName}@${branchName}`,
    description: `Route PR review comments on ${branchName} to Bot`,
    workspaceId: worktreeId,
    evalMode: 'auto',
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: ['github'],
      sourceInstanceIds: [],
      eventTypes: [
        'github.pull_request_review_comment.created',
        'github.issue_comment.created',
      ],
      allowedActors: [],
      conditions: [
        { op: 'not_bot_actor' },
        { op: 'eq', pointer: '/branch', value: branchName },
      ],
    },
    temporal: null,
    targets: [
      {
        kind: 'bot',
        memberId: 'pr-review-bot',
        conversationScope: 'per_thread_topic',
        mailboxPolicy: 'fifo_serial',
        subscribeThread: true,
        promptTemplate: `Review PR comment on ${repoName}@${branchName}: {{payload.comment.body}}`,
      },
    ],
  };
}

export function PulseGuardMenu({
  repoName,
  branchName,
  worktreeId,
}: {
  repoName: string;
  branchName: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<PulseRuleView[]>([]);
  const [subscriptions, setSubscriptions] = useState<PulseSubscriptionView[]>(
    []
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const ciRuleName = `CI Guard: ${repoName}@${branchName}`;
  const prRuleName = `PR Review Guard: ${repoName}@${branchName}`;
  const prThreadKey = `github:${repoName}#${branchName}`;

  const ciRule = rules.find((rule) => rule.spec.name === ciRuleName) ?? null;
  const prRule = rules.find((rule) => rule.spec.name === prRuleName) ?? null;
  const prSub =
    subscriptions.find(
      (sub) => sub.threadKey === prThreadKey && sub.active
    ) ?? null;

  const activeGuardCount =
    (ciRule?.enabled ? 1 : 0) +
    (prRule?.enabled ? 1 : 0) +
    (prSub ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    pulseApi
      .deckSnapshot()
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        setRules(Array.isArray(snapshot.rules) ? snapshot.rules : []);
        setSubscriptions(
          Array.isArray(snapshot.subscriptions) ? snapshot.subscriptions : []
        );
      })
      .catch(() => {
        // Best-effort snapshot load when menu opens.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleToggleRule = async (
    key: 'ci' | 'pr',
    existing: PulseRuleView | null,
    spec: PulseRuleSpec
  ) => {
    setBusyKey(key);
    setStatusError(null);
    try {
      const updated = existing
        ? await pulseApi.setRuleEnabled(existing.id, !existing.enabled)
        : await pulseApi.saveRule({ enabled: true, spec });
      setRules((current) => {
        const idx = current.findIndex((item) => item.id === updated.id);
        if (idx < 0) return [...current, updated];
        return current.map((item) => (item.id === updated.id ? updated : item));
      });
      void queryClient.invalidateQueries({
        queryKey: ['pulse-deck-snapshot'],
      });
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : 'Failed to update branch guard.'
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleThreadSubscription = async () => {
    setBusyKey('thread');
    setStatusError(null);
    try {
      if (prSub) {
        await pulseApi.unsubscribeThread(prSub.id);
        setSubscriptions((current) =>
          current.filter((item) => item.id !== prSub.id)
        );
      } else {
        const created = await pulseApi.subscribeThread(
          prThreadKey,
          'session',
          worktreeId
        );
        setSubscriptions((current) => [...current, created]);
      }
      void queryClient.invalidateQueries({
        queryKey: ['pulse-deck-snapshot'],
      });
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : 'Failed to update PR subscription.'
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="PR Pulse Guard"
          data-testid="branch-pulse-guard-trigger"
          className={cn(
            'branch-info-action gap-1 px-2',
            activeGuardCount > 0 && 'text-primary'
          )}
        >
          <Shield className="h-3.5 w-3.5" aria-hidden="true" />
          {activeGuardCount > 0 ? (
            <span className="text-[11px] font-medium tabular-nums">
              {activeGuardCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-80 space-y-2 border border-border bg-popover p-2.5 text-foreground shadow-md"
        data-testid="branch-pulse-guard-popover"
      >
        <div className="flex items-center justify-between border-b border-border pb-1.5">
          <span className="text-xs font-semibold">PR Automation Guard</span>
          <span className="max-w-36 truncate font-mono text-[11px] text-muted-foreground">
            {branchName}
          </span>
        </div>

        <div className="space-y-1">
          <button
            type="button"
            disabled={busyKey !== null}
            data-testid="pulse-guard-ci-failure"
            onClick={() =>
              void handleToggleRule(
                'ci',
                ciRule,
                buildCiGuardSpec(repoName, branchName, worktreeId)
              )
            }
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted"
          >
            <span>Auto-diagnose CI failure (Fresh Session)</span>
            <span
              className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                ciRule?.enabled
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted/40'
              )}
            >
              {ciRule?.enabled ? <Check className="h-3 w-3" /> : null}
            </span>
          </button>

          <button
            type="button"
            disabled={busyKey !== null}
            data-testid="pulse-guard-pr-comments"
            onClick={() =>
              void handleToggleRule(
                'pr',
                prRule,
                buildPrReviewGuardSpec(repoName, branchName, worktreeId)
              )
            }
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted"
          >
            <span>Route PR review comments to Bot</span>
            <span
              className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                prRule?.enabled
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted/40'
              )}
            >
              {prRule?.enabled ? <Check className="h-3 w-3" /> : null}
            </span>
          </button>

          <button
            type="button"
            disabled={busyKey !== null}
            data-testid="pulse-guard-subscribe-pr"
            onClick={() => void handleToggleThreadSubscription()}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted"
          >
            <span>Subscribe current branch PR thread</span>
            <span
              className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                prSub
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted/40'
              )}
            >
              {prSub ? <Check className="h-3 w-3" /> : null}
            </span>
          </button>
        </div>

        {statusError ? (
          <div role="alert" className="text-[11px] text-destructive">
            {statusError}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
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
      {i18n.t('panels:ui.branch.gitActions')}
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
                aria-label={i18n.t(
                  'panels:ui.branch.targetBranchTargetBranchName',
                  { target_branch_name: repo.target_branch_name }
                )}
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
            {i18n.t('panels:ui.branch.targetBranchLabel', {
              branch: repo.target_branch_name,
            })}
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
