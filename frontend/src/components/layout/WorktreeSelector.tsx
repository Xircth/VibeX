import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export function WorktreeSelector() {
  const [open, setOpen] = useState(false);
  const [copiedWorktreeId, setCopiedWorktreeId] = useState<string | null>(null);
  const copiedResetTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const { attemptId: rawAttemptId } = useParams<{ attemptId?: string }>();
  const routeWorktreeId =
    rawAttemptId && rawAttemptId !== 'latest' ? rawAttemptId : undefined;

  const { projectId, project } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);
  const { data: repos } = useProjectRepos(projectId);
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { data: routeWorkspace } = useTaskAttempt(routeWorktreeId);

  const setActiveTab = useLayoutStore((state) => state.setActiveTab);

  const effectiveWorktreeId = activeWorktreeId ?? routeWorktreeId ?? null;
  const activeWorktree = worktrees.find(
    (worktree) => worktree.workspace.id === effectiveWorktreeId
  );
  const visibleWorktrees = useMemo(() => {
    if (worktrees.length > 0) {
      return worktrees;
    }

    if (routeWorkspace && effectiveWorktreeId) {
      return [{ workspace: routeWorkspace, task: null }];
    }

    return [];
  }, [effectiveWorktreeId, routeWorkspace, worktrees]);
  const projectRootBranchLabel =
    primaryRepoBranches.find((branch) => branch.is_current)?.name ??
    primaryRepo?.default_target_branch ??
    project?.default_main_branch ??
    null;

  const handleSelect = useCallback(
    (worktreeInfo: (typeof worktrees)[number]) => {
      setOpen(false);
      if (!projectId) return;
      if (worktreeInfo.workspace.id === effectiveWorktreeId) return;

      setActiveTab('workspace');
      navigate(
        paths.attempt(
          projectId,
          worktreeInfo.workspace.task_id,
          worktreeInfo.workspace.id
        )
      );
    },
    [effectiveWorktreeId, navigate, projectId, setActiveTab]
  );

  const handleGoToKanban = useCallback(() => {
    setOpen(false);
    if (!projectId) return;

    setActiveTab('kanban');
    navigate(paths.projectTasks(projectId));
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
      worktree: (typeof worktrees)[number]
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const containerRef = worktree.workspace.container_ref;
      if (!containerRef) return;

      try {
        await navigator.clipboard.writeText(containerRef);
        setCopiedWorktreeId(worktree.workspace.id);
        if (copiedResetTimerRef.current) {
          window.clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = window.setTimeout(() => {
          setCopiedWorktreeId((current) =>
            current === worktree.workspace.id ? null : current
          );
        }, 1800);
      } catch (error) {
        console.warn('Copy workspace path failed:', error);
      }
    },
    []
  );

  const displayLabel = activeWorktree
    ? activeWorktree.workspace.branch ||
      activeWorktree.task?.title ||
      'Workspace'
    : effectiveWorktreeId
      ? (routeWorkspace?.branch ?? 'Workspace')
      : (projectRootBranchLabel ?? project?.name ?? 'Select workspace');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="ml-2 h-7 w-36 justify-between gap-1 px-2 text-xs sm:w-48"
          aria-label="Select worktree"
        >
          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72">
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

        {visibleWorktrees.length > 0 ? (
          visibleWorktrees.map((worktree) => (
            <DropdownMenuItem
              key={worktree.workspace.id}
              onSelect={(event) => {
                event.preventDefault();
                handleSelect(worktree);
              }}
              className={cn(
                'flex items-center gap-2',
                worktree.workspace.id === effectiveWorktreeId && 'bg-accent'
              )}
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-mono">
                  {worktree.workspace.branch}
                </span>
                {worktree.task && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {worktree.task.title}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  worktree.workspace.container_ref
                    ? copiedWorktreeId === worktree.workspace.id
                      ? '已复制工作区路径'
                      : '复制工作区路径'
                    : '当前工作区无可复制路径'
                }
                disabled={!worktree.workspace.container_ref}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => void handleCopyWorkspacePath(event, worktree)}
              >
                {copiedWorktreeId === worktree.workspace.id ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </DropdownMenuItem>
          ))
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
