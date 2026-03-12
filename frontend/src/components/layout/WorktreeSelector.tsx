import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, GitBranch } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { paths } from '@/lib/paths';

export function WorktreeSelector() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { projectId, project } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);

  const activeWorktree = worktrees.find((w) => w.workspace.id === activeWorktreeId);

  const handleSelect = useCallback(
    (worktreeInfo: typeof worktrees[number]) => {
      setOpen(false);
      if (!projectId) return;
      if (worktreeInfo.workspace.id === activeWorktreeId) return;

      setActiveTab('workspace');
      navigate(paths.attempt(projectId, worktreeInfo.workspace.task_id, worktreeInfo.workspace.id));
    },
    [activeWorktreeId, projectId, navigate, setActiveTab]
  );

  const handleGoToKanban = useCallback(() => {
    setOpen(false);
    if (!projectId) return;

    setActiveTab('kanban');
    navigate(paths.projectTasks(projectId));
  }, [projectId, navigate, setActiveTab]);

  // Display label
  const displayLabel = activeWorktree
    ? activeWorktree.workspace.branch || activeWorktree.task?.title || 'Workspace'
    : project?.name ?? '选择工作区';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="ml-2 h-7 w-36 justify-between gap-1 px-2 sm:w-48 text-xs"
          aria-label="Select worktree"
        >
          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {/* Kanban overview link */}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            handleGoToKanban();
          }}
          className={!activeWorktreeId ? 'bg-accent' : ''}
        >
          <span className="text-xs">看板总览</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {/* Worktree list */}
        {worktrees.length > 0 ? (
          worktrees.map((wt) => (
            <DropdownMenuItem
              key={wt.workspace.id}
              onSelect={(event) => {
                event.preventDefault();
                handleSelect(wt);
              }}
              className={wt.workspace.id === activeWorktreeId ? 'bg-accent' : ''}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-xs font-mono truncate">{wt.workspace.branch}</span>
                {wt.task && (
                  <span className="text-[10px] text-muted-foreground truncate">{wt.task.title}</span>
                )}
              </div>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            <span className="text-xs text-muted-foreground">暂无活跃工作区</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
