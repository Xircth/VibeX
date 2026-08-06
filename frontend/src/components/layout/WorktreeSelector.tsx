import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, ChevronDown, Copy, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectRepos } from '@/hooks';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { cn } from '@/lib/utils';
import { paths } from '@/lib/paths';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { sessionsApi } from '@/lib/api';
import {
  buildWorkspaceBranchOptions,
  findWorkspaceBranchOptionByWorkspaceId,
  matchesWorkspaceBranch,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';

function getBranchOptionDescription(
  option: WorkspaceBranchOption,
  t: TFunction<['panels', 'common']>
) {
  if (option.useWorktree) {
    return option.workspace?.name?.trim()
      ? `${option.workspace.name} · Git Worktree`
      : 'Git Worktree';
  }

  return option.isCurrentProjectBranch
    ? t('worktreeSelector.currentProjectBranch')
    : t('worktreeSelector.nonWorktreeCheckout');
}

export function WorktreeSelector() {
  const { t } = useTranslation(['panels', 'common']);
  const [open, setOpen] = useState(false);
  const [copiedWorkspaceId, setCopiedWorkspaceId] = useState<string | null>(
    null
  );
  const copiedResetTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const { projectId, project } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);
  const { data: repos } = useProjectRepos(projectId);
  const workspaceRepoNames = useMemo(
    () => repos?.map((repo) => ({ name: repo.name })) ?? [],
    [repos]
  );
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { data: routeWorkspace } = useTaskAttempt(workspaceId);

  const setActiveTab = useLayoutStore((state) => state.setActiveTab);

  const effectiveWorktreeId = activeWorktreeId ?? workspaceId ?? null;
  const visibleWorkspaces = useMemo(() => {
    const nextWorkspaces = worktrees.map((item) => item.workspace);

    if (
      routeWorkspace &&
      effectiveWorktreeId &&
      !nextWorkspaces.some((workspace) => workspace.id === routeWorkspace.id)
    ) {
      nextWorkspaces.unshift(routeWorkspace);
    }

    return nextWorkspaces;
  }, [effectiveWorktreeId, routeWorkspace, worktrees]);
  const branchOptions = useMemo(
    () =>
      buildWorkspaceBranchOptions({
        workspaces: visibleWorkspaces,
        repoBranches: primaryRepoBranches,
      }),
    [primaryRepoBranches, visibleWorkspaces]
  );
  const activeBranchOption = useMemo(
    () =>
      findWorkspaceBranchOptionByWorkspaceId(
        branchOptions,
        effectiveWorktreeId
      ),
    [branchOptions, effectiveWorktreeId]
  );
  const projectRootBranchLabel =
    primaryRepoBranches.find((branch) => branch.is_current)?.name ??
    primaryRepo?.default_target_branch ??
    project?.default_main_branch ??
    null;

  const switchBranchMutation = useMutation({
    mutationFn: async (branch: string) => {
      if (!projectId) {
        throw new Error('Project is required');
      }

      return sessionsApi.ensureProjectWorkspace({
        project_id: projectId,
        branch,
      });
    },
    onSuccess: async (workspace) => {
      if (!projectId) {
        return;
      }

      if (primaryRepo?.id) {
        await queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepo.id],
        });
      }
      await queryClient.invalidateQueries({
        queryKey: ['projectWorktrees', projectId],
      });

      setActiveTab('workspace');
      navigate(paths.projectWorkspace(projectId, workspace.id));
    },
  });

  const handleSelect = useCallback(
    (option: WorkspaceBranchOption) => {
      setOpen(false);
      if (!projectId) {
        return;
      }

      if (
        effectiveWorktreeId &&
        activeBranchOption &&
        matchesWorkspaceBranch(activeBranchOption.branch, option.branch) &&
        activeBranchOption.existingWorkspaceId === effectiveWorktreeId
      ) {
        return;
      }

      if (option.useWorktree && option.directWorkspaceId) {
        setActiveTab('workspace');
        navigate(paths.projectWorkspace(projectId, option.directWorkspaceId));
        return;
      }

      switchBranchMutation.mutate(option.branch);
    },
    [
      activeBranchOption,
      effectiveWorktreeId,
      navigate,
      projectId,
      setActiveTab,
      switchBranchMutation,
    ]
  );

  const handleGoToKanban = useCallback(() => {
    setOpen(false);
    if (!projectId) return;

    setActiveTab('kanban');
    navigate(paths.projectSessions(projectId));
  }, [navigate, projectId, setActiveTab]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  const handleCopyWorkspacePath = useCallback(
    async (
      event: React.MouseEvent<HTMLButtonElement>,
      option: WorkspaceBranchOption
    ) => {
      event.preventDefault();
      event.stopPropagation();

      if (!option.workspace) {
        return;
      }

      const workspacePath = deriveWorkspaceRootPath(
        option.workspace,
        workspaceRepoNames
      );
      if (!workspacePath) return;

      try {
        await navigator.clipboard.writeText(workspacePath);
        setCopiedWorkspaceId(option.workspace.id);
        if (copiedResetTimerRef.current) {
          window.clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = window.setTimeout(() => {
          setCopiedWorkspaceId((current) =>
            current === option.workspace?.id ? null : current
          );
        }, 1800);
      } catch (error) {
        console.warn('Copy workspace path failed:', error);
      }
    },
    [workspaceRepoNames]
  );

  const displayLabel = activeBranchOption?.branch
    ? activeBranchOption.branch
    : effectiveWorktreeId
      ? (routeWorkspace?.branch ?? 'Workspace')
      : (projectRootBranchLabel ?? project?.name ?? 'Select workspace');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-7 w-36 justify-between gap-1 px-2 text-xs sm:w-48"
          aria-label="Select workspace"
          disabled={switchBranchMutation.isPending}
        >
          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            handleGoToKanban();
          }}
          className={!effectiveWorktreeId ? 'bg-accent' : ''}
        >
          <span className="text-xs">Kanban overview</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {branchOptions.length > 0 ? (
          branchOptions.map((option) => {
            const copyPath = option.workspace
              ? deriveWorkspaceRootPath(option.workspace, workspaceRepoNames)
              : null;

            return (
              <DropdownMenuItem
                key={option.value}
                onSelect={(event) => {
                  event.preventDefault();
                  handleSelect(option);
                }}
                className={cn(
                  'flex items-center gap-2',
                  option.existingWorkspaceId === effectiveWorktreeId &&
                    'bg-accent'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="block truncate text-xs font-mono">
                      {option.branch}
                    </span>
                    <span
                      className={
                        option.useWorktree
                          ? 'rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary'
                          : 'rounded-full bg-[hsl(var(--warning)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--warning))]'
                      }
                    >
                      {option.useWorktree ? 'Worktree' : 'Project'}
                    </span>
                  </div>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {getBranchOptionDescription(option, t)}
                  </span>
                </div>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    copyPath
                      ? copiedWorkspaceId === option.existingWorkspaceId
                        ? t('worktreeSelector.copiedWorkspacePath')
                        : t('worktreeSelector.copyWorkspacePath')
                      : t('worktreeSelector.noCopyablePath')
                  }
                  disabled={!copyPath}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) =>
                    void handleCopyWorkspacePath(event, option)
                  }
                >
                  {copiedWorkspaceId === option.existingWorkspaceId ? (
                    <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </DropdownMenuItem>
            );
          })
        ) : (
          <>
            {projectRootBranchLabel ? (
              <DropdownMenuItem disabled>
                <span className="text-xs text-muted-foreground">
                  Current project branch: {projectRootBranchLabel}
                </span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled>
              <span className="text-xs text-muted-foreground">
                No active workspaces
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
