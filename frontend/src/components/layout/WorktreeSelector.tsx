import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  Copy,
  GitBranch as GitBranchIcon,
} from 'lucide-react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import type { GitBranch, Session, Workspace } from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useProjectRepos } from '@/hooks';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { paths } from '@/lib/paths';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { attemptsApi, sessionsApi, type SessionSummary } from '@/lib/api';
import { conversationApi } from '@/features/conversation/conversationApi';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  createWorkspaceWithSession,
  type WorkspaceWithSession,
} from '@/types/attempt';
import {
  buildBranchSegment,
  orderWorkspacesForSelector,
  type BranchSegmentEntry,
} from '@/lib/workspaceBranchSegment';

type SwitcherMode = 'workspace' | 'branch';

const SESSION_STALE_MS = 30_000;

function resolveCachedWorkspaceSession(
  queryClient: QueryClient,
  workspaceId: string
): Session | undefined {
  const cachedAttempt = queryClient.getQueryData<WorkspaceWithSession>([
    'taskAttemptWithSession',
    workspaceId,
  ]);
  if (cachedAttempt?.session) {
    return cachedAttempt.session;
  }

  const summaries = queryClient.getQueryData<SessionSummary[]>([
    'workspaceSessions',
    workspaceId,
    'summaries',
  ]);
  const latestSummary =
    summaries?.find((summary) => summary.status !== 'archived') ??
    summaries?.[0];
  if (!latestSummary) {
    return undefined;
  }

  return (
    queryClient.getQueryData<Session>(['session', latestSummary.id]) ?? {
      id: latestSummary.id,
      workspace_id: latestSummary.workspace_id,
      task_id: latestSummary.task_id,
      name: latestSummary.name,
      initial_prompt: latestSummary.first_prompt,
      status: latestSummary.status,
      executor: latestSummary.executor,
      external_session_id: null,
      agent_id: latestSummary.agent_id,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: latestSummary.created_at,
      updated_at: latestSummary.updated_at,
    }
  );
}

/**
 * The file tree reads `attempt`. Session follow reads `taskAttempt`.
 * Both have to be warm before the route changes, or the old directory stays.
 */
function rememberWorkspace(
  queryClient: QueryClient,
  workspace: Workspace,
  session?: Session
) {
  queryClient.setQueryData(['attempt', workspace.id], workspace);
  queryClient.setQueryData(['taskAttempt', workspace.id], workspace);
  if (session) {
    queryClient.setQueryData(['session', session.id], session);
    queryClient.setQueryData(
      ['taskAttemptWithSession', workspace.id],
      createWorkspaceWithSession(workspace, session)
    );
    return;
  }

  const summaries = queryClient.getQueryData<SessionSummary[]>([
    'workspaceSessions',
    workspace.id,
    'summaries',
  ]);
  if (
    summaries &&
    summaries.length === 0 &&
    !queryClient.getQueryData(['taskAttemptWithSession', workspace.id])
  ) {
    queryClient.setQueryData(
      ['taskAttemptWithSession', workspace.id],
      createWorkspaceWithSession(workspace, undefined)
    );
  }
}

function checkoutErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

export function WorktreeSelector() {
  const { t } = useTranslation('panels');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SwitcherMode>('workspace');
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const branchSwitchLockRef = useRef(false);
  const [copiedWorkspaceId, setCopiedWorkspaceId] = useState<string | null>(
    null
  );
  const copiedResetTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const { projectId, project } = useProject();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { activateExecutionSession } = useKanbanSessionContext();
  const { worktrees } = useProjectWorktrees(projectId);
  const { data: repos } = useProjectRepos(projectId);
  const workspaceRepoNames = useMemo(
    () => repos?.map((repo) => ({ name: repo.name, path: repo.path })) ?? [],
    [repos]
  );
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { data: routeWorkspace } = useTaskAttempt(workspaceId);
  const setActiveTab = useLayoutStore((state) => state.setActiveTab);
  const setRootPath = useFileTreeStore((state) => state.setRootPath);
  const setSelectedFilePath = useFileTreeStore(
    (state) => state.setSelectedFilePath
  );
  const setDiffFilePath = useFileTreeStore((state) => state.setDiffFilePath);

  const selectorWorkspaces = useMemo(() => {
    const nextWorkspaces = worktrees.map((item) => item.workspace);
    if (
      routeWorkspace &&
      !nextWorkspaces.some((workspace) => workspace.id === routeWorkspace.id)
    ) {
      nextWorkspaces.unshift(routeWorkspace);
    }
    return orderWorkspacesForSelector(nextWorkspaces);
  }, [routeWorkspace, worktrees]);
  const projectRootWorkspace =
    selectorWorkspaces.find((workspace) => !workspace.use_worktree) ?? null;
  const effectiveWorktreeId =
    activeWorktreeId ?? workspaceId ?? projectRootWorkspace?.id ?? null;
  const activeWorkspace = useMemo(
    () =>
      selectorWorkspaces.find(
        (workspace) => workspace.id === effectiveWorktreeId
      ) ?? (routeWorkspace?.id === effectiveWorktreeId ? routeWorkspace : null),
    [effectiveWorktreeId, routeWorkspace, selectorWorkspaces]
  );
  const inWorktree = Boolean(activeWorkspace?.use_worktree);
  const mainDirectoryBranch =
    primaryRepoBranches.find((branch) => branch.is_current)?.name ??
    primaryRepo?.default_target_branch ??
    null;
  const currentDirectoryBranch = inWorktree
    ? (activeWorkspace?.branch ?? null)
    : (mainDirectoryBranch ?? activeWorkspace?.branch ?? null);
  const branchEntries = useMemo(
    () =>
      buildBranchSegment({
        branches: primaryRepoBranches,
        inWorktree,
        currentDirectoryBranch,
        mainDirectoryBranch,
        projectRootWorkspaceId: projectRootWorkspace?.id ?? null,
      }),
    [
      currentDirectoryBranch,
      inWorktree,
      mainDirectoryBranch,
      primaryRepoBranches,
      projectRootWorkspace?.id,
    ]
  );

  const displayLabel =
    currentDirectoryBranch?.trim() ||
    activeWorkspace?.branch?.trim() ||
    mainDirectoryBranch ||
    project?.name ||
    t('worktreeSelector.triggerLabel');

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  const prefetchWorkspaceSession = useCallback(
    (workspace: Workspace) => {
      const session = resolveCachedWorkspaceSession(queryClient, workspace.id);
      rememberWorkspace(queryClient, workspace, session);
      if (session?.id) {
        conversationApi.prefetchDetail(session.id);
        return;
      }
      void queryClient.prefetchQuery({
        queryKey: ['taskAttemptWithSession', workspace.id],
        queryFn: () => attemptsApi.getWithSession(workspace.id),
        staleTime: SESSION_STALE_MS,
      });
    },
    [queryClient]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    selectorWorkspaces.forEach((workspace) => {
      const session = resolveCachedWorkspaceSession(queryClient, workspace.id);
      rememberWorkspace(queryClient, workspace, session);
    });
  }, [open, queryClient, selectorWorkspaces]);

  const activateWorkspace = useCallback(
    (workspace: Workspace) => {
      setOpen(false);
      const isAlreadyBoundToTarget =
        workspace.id === effectiveWorktreeId &&
        workspace.id === activeWorktreeId &&
        (!workspaceId || workspace.id === workspaceId);
      if (!projectId || isAlreadyBoundToTarget) {
        return;
      }

      const session = resolveCachedWorkspaceSession(queryClient, workspace.id);
      rememberWorkspace(queryClient, workspace, session);
      const sessionId = session?.id;
      if (sessionId) {
        conversationApi.prefetchDetail(sessionId);
        activateExecutionSession({
          sessionId,
          workspaceId: workspace.id,
        });
      }

      setRootPath(deriveWorkspaceRootPath(workspace, workspaceRepoNames));
      setSelectedFilePath(null);
      setDiffFilePath(null);
      setActiveWorktree(workspace.id, workspace.task_id);
      setActiveTab('workspace');
      navigate(
        sessionId
          ? paths.projectSession(projectId, workspace.id, sessionId)
          : paths.projectWorkspace(projectId, workspace.id)
      );
    },
    [
      activateExecutionSession,
      activeWorktreeId,
      effectiveWorktreeId,
      navigate,
      projectId,
      queryClient,
      setActiveTab,
      setActiveWorktree,
      setDiffFilePath,
      setRootPath,
      setSelectedFilePath,
      workspaceId,
      workspaceRepoNames,
    ]
  );

  const checkoutDirectoryBranch = useCallback(
    async (branchName: string) => {
      if (
        !effectiveWorktreeId ||
        !primaryRepo?.id ||
        branchSwitchLockRef.current
      ) {
        return;
      }

      branchSwitchLockRef.current = true;
      setSwitchingBranch(true);
      try {
        const result = await ConfirmDialog.show({
          title: t('worktreeSelector.branchSwitchTitle'),
          message: t('worktreeSelector.branchSwitchMessage'),
          confirmText: t('worktreeSelector.branchSwitchConfirm'),
          cancelText: t('worktreeSelector.branchSwitchCancel'),
          variant: 'info',
        });
        if (result !== 'confirmed') {
          return;
        }

        const previousBranch = currentDirectoryBranch;
        await attemptsApi.checkoutBranch(
          effectiveWorktreeId,
          primaryRepo.id,
          branchName
        );
        const withBranch = (workspace: Workspace) =>
          workspace.id === effectiveWorktreeId
            ? { ...workspace, branch: branchName }
            : workspace;
        queryClient.setQueryData<Workspace[]>(
          ['projectWorktrees', projectId],
          (current) => current?.map(withBranch)
        );
        queryClient.setQueryData<Workspace>(
          ['taskAttempt', effectiveWorktreeId],
          (current) => (current ? withBranch(current) : current)
        );
        queryClient.setQueryData<Workspace>(
          ['attempt', effectiveWorktreeId],
          (current) => (current ? withBranch(current) : current)
        );
        queryClient.setQueryData<WorkspaceWithSession>(
          ['taskAttemptWithSession', effectiveWorktreeId],
          (current) =>
            current
              ? { ...withBranch(current), session: current.session }
              : current
        );
        if (primaryRepo.id) {
          queryClient.setQueryData<GitBranch[]>(
            ['repoBranches', primaryRepo.id],
            (current) =>
              current?.map((branch) => {
                const isTarget =
                  branch.name.trim().toLowerCase() ===
                  branchName.trim().toLowerCase();
                const isPrevious =
                  previousBranch != null &&
                  branch.name.trim().toLowerCase() ===
                    previousBranch.trim().toLowerCase();
                if (!inWorktree) {
                  return {
                    ...branch,
                    is_current: isTarget,
                  };
                }
                if (isTarget) {
                  return {
                    ...branch,
                    is_worktree: true,
                    worktree_path:
                      activeWorkspace?.container_ref ?? branch.worktree_path,
                  };
                }
                if (isPrevious) {
                  return {
                    ...branch,
                    is_worktree: false,
                    worktree_path: null,
                  };
                }
                return branch;
              })
          );
          void queryClient.invalidateQueries({
            queryKey: ['repoBranches', primaryRepo.id],
          });
        }
        void queryClient.invalidateQueries({
          queryKey: ['projectWorktrees', projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['workspaceBranchStatus', effectiveWorktreeId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['taskAttempt', effectiveWorktreeId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['taskAttemptWithSession', effectiveWorktreeId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['attempt', effectiveWorktreeId],
        });
      } catch (error) {
        toast.error(
          checkoutErrorMessage(error, t('worktreeSelector.branchSwitchFailed'))
        );
      } finally {
        branchSwitchLockRef.current = false;
        setSwitchingBranch(false);
      }
    },
    [
      activeWorkspace?.container_ref,
      currentDirectoryBranch,
      effectiveWorktreeId,
      inWorktree,
      primaryRepo?.id,
      projectId,
      queryClient,
      t,
    ]
  );

  const handleBranchSelect = useCallback(
    (entry: BranchSegmentEntry) => {
      setOpen(false);
      if (entry.role === 'current') {
        return;
      }
      if (entry.role === 'main-directory') {
        const target =
          selectorWorkspaces.find(
            (workspace) => workspace.id === entry.workspaceId
          ) ?? projectRootWorkspace;
        if (target) {
          activateWorkspace(target);
          return;
        }
        if (!projectId) {
          toast.error(t('worktreeSelector.branchSwitchFailed'));
          return;
        }
        void sessionsApi
          .ensureProjectWorkspace({
            project_id: projectId,
            branch: entry.name,
          })
          .then((workspace) => {
            activateWorkspace(workspace);
          })
          .catch((error) => {
            toast.error(
              checkoutErrorMessage(
                error,
                t('worktreeSelector.branchSwitchFailed')
              )
            );
          });
        return;
      }
      void checkoutDirectoryBranch(entry.name);
    },
    [
      activateWorkspace,
      checkoutDirectoryBranch,
      projectId,
      projectRootWorkspace,
      selectorWorkspaces,
      t,
    ]
  );

  const handleCopyWorkspacePath = useCallback(
    async (
      event: React.MouseEvent<HTMLButtonElement>,
      workspace: Workspace
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const workspacePath = deriveWorkspaceRootPath(
        workspace,
        workspaceRepoNames
      );
      if (!workspacePath) {
        return;
      }

      try {
        await navigator.clipboard.writeText(workspacePath);
        setCopiedWorkspaceId(workspace.id);
        if (copiedResetTimerRef.current) {
          window.clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = window.setTimeout(() => {
          setCopiedWorkspaceId((current) =>
            current === workspace.id ? null : current
          );
        }, 1800);
      } catch (error) {
        console.warn('Copy workspace path failed:', error);
      }
    },
    [workspaceRepoNames]
  );

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setMode('workspace');
    }
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-7 w-36 justify-between gap-1 px-2 text-xs sm:w-48"
          aria-label={t('worktreeSelector.triggerLabel')}
          data-testid="workspace-switcher"
          disabled={switchingBranch}
        >
          <GitBranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-80 overflow-hidden p-0">
        <div
          className="border-b border-border/60 p-2"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <SegmentedControl
            className="w-full"
            layout="fill"
            size="sm"
            value={mode}
            onChange={(value) => {
              if (value === 'workspace' || value === 'branch') {
                setMode(value);
              }
            }}
            label={t('worktreeSelector.modeLabel')}
            data-testid="workspace-switcher-mode"
          >
            <SegmentedControlItem
              value="workspace"
              label={t('worktreeSelector.modeWorkspace')}
            />
            <SegmentedControlItem
              value="branch"
              label={t('worktreeSelector.modeBranch')}
            />
          </SegmentedControl>
        </div>

        <div
          className="max-h-72 overflow-y-auto overscroll-contain p-1"
          data-testid="workspace-switcher-list"
        >
          {mode === 'workspace' ? (
            selectorWorkspaces.length > 0 ? (
              selectorWorkspaces.map((workspace) => {
                const copyPath = deriveWorkspaceRootPath(
                  workspace,
                  workspaceRepoNames
                );
                const copyLabel = copyPath
                  ? copiedWorkspaceId === workspace.id
                    ? t('worktreeSelector.copiedWorkspacePath')
                    : t('worktreeSelector.copyWorkspacePath')
                  : t('worktreeSelector.noCopyablePath');
                const selected = workspace.id === effectiveWorktreeId;

                return (
                  <div key={workspace.id} className="flex items-center gap-1">
                    <DropdownMenuItem
                      className="min-w-0 flex-1 gap-2"
                      onSelect={(event) => {
                        event.preventDefault();
                        activateWorkspace(workspace);
                      }}
                      onMouseEnter={() => prefetchWorkspaceSession(workspace)}
                      onFocus={() => prefetchWorkspaceSession(workspace)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {workspace.use_worktree
                          ? workspace.branch
                          : mainDirectoryBranch || workspace.branch}
                      </span>
                      <span
                        className={
                          workspace.use_worktree
                            ? 'shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary'
                            : 'shrink-0 rounded-full bg-[hsl(var(--warning)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--warning))]'
                        }
                      >
                        {workspace.use_worktree
                          ? t('worktreeSelector.worktree')
                          : t('worktreeSelector.mainDirectory')}
                      </span>
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        {selected ? (
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={copyLabel}
                      title={copyLabel}
                      disabled={!copyPath}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) =>
                        void handleCopyWorkspacePath(event, workspace)
                      }
                    >
                      {copiedWorkspaceId === workspace.id ? (
                        <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('worktreeSelector.emptyWorkspaces')}
              </p>
            )
          ) : branchEntries.length > 0 ? (
            branchEntries.map((entry) => (
              <DropdownMenuItem
                key={`${entry.role}:${entry.name}`}
                className="gap-2"
                onSelect={(event) => {
                  event.preventDefault();
                  handleBranchSelect(entry);
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {entry.name}
                </span>
                {entry.role === 'main-directory' ? (
                  <span className="shrink-0 rounded-full bg-[hsl(var(--warning)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--warning))]">
                    {t('worktreeSelector.mainDirectory')}
                  </span>
                ) : null}
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {entry.role === 'current' ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('worktreeSelector.emptyBranches')}
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
