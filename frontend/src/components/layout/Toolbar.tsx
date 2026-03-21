import { Link, useNavigate, useParams } from 'react-router-dom';
import { attemptsApi, settingsWindowApi } from '@/lib/api';
import { useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  FolderOpen,
  Settings,
  Menu,
  Plus,
  PanelLeft,
  PanelRight,
  Terminal,
  RotateCcw,
  FolderTree,
  GitBranch,
  Columns2,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  LayoutDashboard,
  Monitor,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Logo } from '@/components/Logo';
import { openTaskForm } from '@/lib/openTaskForm';
import { paths } from '@/lib/paths';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useOpenProjectInEditor } from '@/hooks/useOpenProjectInEditor';
import { OpenInIdeButton } from '@/components/ide/OpenInIdeButton';
import { useProjectRepos } from '@/hooks';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { useLayoutStore } from '@/stores/useLayoutStore';
import type { WorkspaceTab } from '@/stores/useLayoutStore';
import { usePanelActions } from '@/hooks/usePanelActions';
import { cn } from '@/lib/utils';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { WorktreeSelector } from '@/components/layout/WorktreeSelector';

function ToolbarDivider() {
  return (
    <div
      className="mx-1 h-6 w-px bg-border/60"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

/**
 * BranchStatusBadge - Shows branch ahead/behind status in the toolbar.
 * Only renders when viewing a workspace with branch status data.
 */
function BranchStatusBadge({ workspaceId }: { workspaceId: string }) {
  const { data: branchStatus } = useWorkspaceBranchStatus(workspaceId);

  const statusSummary = useMemo(() => {
    if (!branchStatus?.length) return null;
    // Aggregate across repos
    let totalAhead = 0;
    let totalBehind = 0;
    let hasConflicts = false;
    let targetBranch = '';

    for (const repo of branchStatus) {
      totalAhead += repo.commits_ahead ?? 0;
      totalBehind += repo.commits_behind ?? 0;
      if (
        repo.is_rebase_in_progress ||
        (repo.conflicted_files?.length ?? 0) > 0
      ) {
        hasConflicts = true;
      }
      if (!targetBranch && repo.target_branch_name) {
        targetBranch = repo.target_branch_name;
      }
    }

    return { totalAhead, totalBehind, hasConflicts, targetBranch };
  }, [branchStatus]);

  if (!statusSummary) return null;

  const { totalAhead, totalBehind, hasConflicts, targetBranch } = statusSummary;

  const tooltipParts: string[] = [];
  if (targetBranch) tooltipParts.push(`Target: ${targetBranch}`);
  if (totalAhead > 0) tooltipParts.push(`${totalAhead} ahead`);
  if (totalBehind > 0) tooltipParts.push(`${totalBehind} behind`);
  if (hasConflicts) tooltipParts.push('Conflicts detected');
  const tooltipText = tooltipParts.join(' | ') || 'Branch status';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          {targetBranch && (
            <span className="max-w-24 truncate">{targetBranch}</span>
          )}
          {hasConflicts ? (
            <AlertTriangle className="h-3 w-3 text-destructive" />
          ) : (
            <>
              {totalAhead > 0 && (
                <span className="flex items-center gap-0.5 text-green-600">
                  <ArrowUp className="h-2.5 w-2.5" />
                  {totalAhead}
                </span>
              )}
              {totalBehind > 0 && (
                <span className="flex items-center gap-0.5 text-orange-500">
                  <ArrowDown className="h-2.5 w-2.5" />
                  {totalBehind}
                </span>
              )}
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Toolbar - The top toolbar for the IDE layout.
 *
 * Contains:
 * - Logo and project selector
 * - Search bar
 * - Panel toggle buttons (file tree, terminal, right panel)
 * - Create task, open in IDE, settings, and navigation menu
 */
function WorkspaceTabSwitcher() {
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { activeWorktreeId, activeTaskId } = useWorktree();
  const { rightSession } = useKanbanSessionContext();
  const { taskId, attemptId } = useParams<{
    taskId?: string;
    attemptId?: string;
  }>();
  const { worktrees } = useProjectWorktrees(projectId);
  const { data: rightSessionWorkspace } = useTaskAttempt(
    rightSession?.workspaceId
  );
  const { activeTab, setActiveTab } = useLayoutStore();
  const routeTab =
    taskId && attemptId ? 'workspace' : !taskId && !attemptId ? 'kanban' : null;
  const effectiveActiveTab = routeTab ?? activeTab;

  const tabs: {
    key: WorkspaceTab;
    label: string;
    icon: typeof LayoutDashboard;
  }[] = [
    { key: 'kanban', label: 'Kanban', icon: LayoutDashboard },
    { key: 'workspace', label: 'Workspace', icon: Monitor },
  ];

  const handleTabSelect = useCallback(
    (tab: WorkspaceTab) => {
      setActiveTab(tab);
      if (!projectId) return;

      if (tab === 'kanban') {
        navigate(paths.projectTasks(projectId));
        return;
      }

      const navigateToFallbackWorkspace = () => {
        const currentAttemptId =
          attemptId && attemptId !== 'latest' ? attemptId : null;
        const currentTaskId = taskId ?? null;
        const activeWorktree =
          worktrees.find(
            (worktree) => worktree.workspace.id === activeWorktreeId
          ) ?? null;
        const fallbackWorktree = activeWorktree ?? worktrees[0] ?? null;
        const targetAttemptId =
          currentAttemptId ??
          activeWorktreeId ??
          fallbackWorktree?.workspace.id ??
          null;
        const targetTaskId =
          currentTaskId ??
          activeTaskId ??
          fallbackWorktree?.workspace.task_id ??
          null;

        if (targetTaskId && targetAttemptId) {
          navigate(paths.attempt(projectId, targetTaskId, targetAttemptId));
        }
      };

      if (effectiveActiveTab === 'kanban' && rightSession) {
        const targetTaskId = rightSessionWorkspace?.task_id;
        if (targetTaskId) {
          navigate(
            paths.attempt(projectId, targetTaskId, rightSession.workspaceId)
          );
          return;
        }

        void attemptsApi
          .get(rightSession.workspaceId)
          .then((workspace) => {
            navigate(
              paths.attempt(
                projectId,
                workspace.task_id,
                rightSession.workspaceId
              )
            );
          })
          .catch(() => {
            navigateToFallbackWorkspace();
          });
        return;
      }

      navigateToFallbackWorkspace();
    },
    [
      activeTaskId,
      activeWorktreeId,
      attemptId,
      effectiveActiveTab,
      navigate,
      projectId,
      rightSession,
      rightSessionWorkspace?.task_id,
      setActiveTab,
      taskId,
      worktrees,
    ]
  );

  return (
    <div className="flex items-center h-7 bg-muted/50 rounded-md p-0.5 gap-0.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = effectiveActiveTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => handleTabSelect(tab.key)}
            className={`flex items-center gap-1.5 px-2.5 h-6 rounded text-xs font-medium transition-all ${
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3 w-3" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toolbar() {
  const { taskId, attemptId } = useParams<{
    taskId?: string;
    attemptId?: string;
  }>();
  const workspaceId =
    attemptId && attemptId !== 'latest' ? attemptId : undefined;
  const { projectId, project } = useProject();
  const handleOpenInEditor = useOpenProjectInEditor(project || null);
  const { data: repos } = useProjectRepos(projectId);
  const isSingleRepoProject = repos?.length === 1;
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab =
    taskId && attemptId ? 'workspace' : !taskId && !attemptId ? 'kanban' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const isWorkspaceTab = effectiveActiveTab === 'workspace';

  const { toggleRightPanel, isRightPanelVisible, resetLayout } =
    useLayoutStore();

  const {
    toggleFileTree,
    openNewTerminal,
    toggleEditorArea,
  } = usePanelActions();

  const handleCreateTask = () => {
    if (projectId) {
      openTaskForm({ mode: 'create', projectId });
    }
  };

  const handleOpenInIDE = () => {
    handleOpenInEditor();
  };

  const handleOpenSettings = useCallback(() => {
    settingsWindowApi.open();
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="w-full px-1.5 bg-secondary/50">
        <div className="relative flex items-center h-9 gap-0.5">
          {/* Left section: Logo + project selector */}
          <div
            className={cn(
              'flex items-center shrink-0 min-w-0',
              !isWorkspaceTab && 'invisible pointer-events-none'
            )}
            aria-hidden={!isWorkspaceTab}
          >
            <Link
              to="/local-projects"
              className="shrink-0"
              aria-label="返回首页"
              title="返回首页"
            >
              <Logo showText={false} />
            </Link>
            <WorktreeSelector />
          </div>

          {/* Branch status badge (visible when viewing a workspace) */}
          {workspaceId && <BranchStatusBadge workspaceId={workspaceId} />}

          {/* Center section: Tab switcher */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <div className="pointer-events-auto">
              <WorkspaceTabSwitcher />
            </div>
          </div>

          {/* Right section: Actions */}
          <div
            className={cn(
              'ml-auto flex items-center shrink-0 gap-0.5',
              !isWorkspaceTab && 'invisible pointer-events-none'
            )}
            aria-hidden={!isWorkspaceTab}
          >
            <div
              className={cn(
                'flex items-center gap-0.5',
                !isWorkspaceTab && 'invisible pointer-events-none'
              )}
              aria-hidden={!isWorkspaceTab}
            >
              {/* Panel toggle buttons */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={toggleFileTree}
                    aria-label="Toggle file tree"
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    <FolderTree className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Toggle File Tree</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={openNewTerminal}
                    aria-label="Toggle terminal"
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    <Terminal className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Toggle Terminal</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={toggleEditorArea}
                    aria-label="Toggle editor area"
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Toggle Editor Area
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={toggleRightPanel}
                    aria-label="Toggle AI panel"
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    {isRightPanelVisible ? (
                      <PanelRight className="h-3.5 w-3.5" />
                    ) : (
                      <PanelLeft className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Toggle AI Panel</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={resetLayout}
                    aria-label="Reset layout"
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Reset Layout</TooltipContent>
              </Tooltip>

              <ToolbarDivider />
            </div>

            {/* Create task + Open in IDE */}
            {projectId && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handleCreateTask}
                      aria-label="Create new task"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New Task</TooltipContent>
                </Tooltip>
                {isSingleRepoProject && (
                  <OpenInIdeButton
                    onClick={handleOpenInIDE}
                    className="h-7 w-7"
                  />
                )}
                <ToolbarDivider />
              </>
            )}

            {/* Settings + Nav menu */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleOpenSettings}
                  aria-label="Settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Settings</TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Main navigation"
                >
                  <Menu className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/local-projects">
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Projects
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
