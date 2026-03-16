import { Link, useParams } from 'react-router-dom';
import { settingsWindowApi } from '@/lib/api';
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
import { useProject } from '@/contexts/ProjectContext';
import { useOpenProjectInEditor } from '@/hooks/useOpenProjectInEditor';
import { OpenInIdeButton } from '@/components/ide/OpenInIdeButton';
import { useProjectRepos } from '@/hooks';
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
      if (repo.is_rebase_in_progress || (repo.conflicted_files?.length ?? 0) > 0) {
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
        <div className="flex items-center gap-1 px-1.5 h-6 rounded text-xs text-muted-foreground border border-border/60 bg-muted/30">
          <GitBranch className="h-3 w-3" />
          {targetBranch && (
            <span className="max-w-20 truncate">{targetBranch}</span>
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
  const { activeTab, setActiveTab } = useLayoutStore();

  const tabs: { key: WorkspaceTab; label: string; icon: typeof LayoutDashboard }[] = [
    { key: 'kanban', label: 'Kanban', icon: LayoutDashboard },
    { key: 'workspace', label: 'Workspace', icon: Monitor },
  ];

  return (
    <div className="flex items-center h-7 bg-muted/50 rounded-md p-0.5 gap-0.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
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
  const { attemptId: workspaceId } = useParams<{ attemptId?: string }>();
  const { projectId, project } = useProject();
  const handleOpenInEditor = useOpenProjectInEditor(project || null);
  const { data: repos } = useProjectRepos(projectId);
  const isSingleRepoProject = repos?.length === 1;

  const {
    toggleRightPanel,
    isRightPanelVisible,
    resetLayout,
  } = useLayoutStore();

  const { toggleFileTree, openNewTerminal, toggleCenter1Visibility, toggleCenter2Visibility, isCenter1Visible, isCenter2Visible } = usePanelActions();

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
        <div className="flex items-center h-9 gap-0.5">
          {/* Left section: Logo + project selector */}
          <div className="flex items-center shrink-0">
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
          <div className="flex-1 flex items-center justify-center px-2 min-w-0">
            <WorkspaceTabSwitcher />
          </div>

          {/* Right section: Actions */}
          <div className="flex items-center shrink-0 gap-0.5">
            {/* Panel toggle buttons */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleFileTree}
                  aria-label="Toggle file tree"
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
                  className={cn("h-7 w-7", isCenter1Visible() && "bg-accent")}
                  onClick={toggleCenter1Visibility}
                  aria-label="Toggle center panel 1"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Toggle Center 1</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-7 w-7", isCenter2Visible() && "bg-accent")}
                  onClick={toggleCenter2Visibility}
                  aria-label="Toggle center panel 2"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Toggle Center 2</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleRightPanel}
                  aria-label="Toggle AI panel"
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
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reset Layout</TooltipContent>
            </Tooltip>

            <ToolbarDivider />

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
