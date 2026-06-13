import { Link, useNavigate, useParams } from 'react-router-dom';
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
  Plus,
  PanelLeft,
  PanelRight,
  Terminal,
  RotateCcw,
  FolderTree,
  Code2,
  GitBranch,
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
import { paths } from '@/lib/paths';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjects } from '@/hooks/useProjects';
import { useOpenProjectInEditor } from '@/hooks/useOpenProjectInEditor';
import { OpenInIdeButton } from '@/components/ide/OpenInIdeButton';
import { useProjectRepos } from '@/hooks';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { PANEL_IDS, useLayoutStore } from '@/stores/useLayoutStore';
import type { WorkspaceTab } from '@/stores/useLayoutStore';
import { usePanelActions } from '@/hooks/usePanelActions';
import { cn } from '@/lib/utils';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { WorktreeSelector } from '@/components/layout/WorktreeSelector';
import { ProjectRailToggleButton } from '@/components/layout/ProjectRailToggleButton';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';

function ToolbarDivider() {
  return (
    <div
      className="workspace-toolbar-divider mx-1 h-6 w-px"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

const MAINLINE_BRANCH_NAMES = new Set(['main', 'master']);
const RECENT_PROJECT_MENU_LIMIT = 6;

function matchesBranch(branch: string, expectedBranch: string) {
  const normalized = branch.trim().toLowerCase();
  const expected = expectedBranch.trim().toLowerCase();
  return normalized === expected || normalized.endsWith(`/${expected}`);
}

function isMainlineBranch(branch: string) {
  const normalized = branch.trim().toLowerCase();
  return (
    MAINLINE_BRANCH_NAMES.has(normalized) ||
    normalized.endsWith('/main') ||
    normalized.endsWith('/master')
  );
}

function BranchStatusBadge({ workspaceId }: { workspaceId: string }) {
  const { data: branchStatus } = useWorkspaceBranchStatus(workspaceId);

  const statusSummary = useMemo(() => {
    if (!branchStatus?.length) return null;
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
        <div className="workspace-branch-status-badge flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs">
          <GitBranch className="h-3 w-3" />
          {targetBranch && (
            <span className="max-w-24 truncate">{targetBranch}</span>
          )}
          {hasConflicts ? (
            <AlertTriangle className="h-3 w-3 text-destructive" />
          ) : (
            <>
              {totalAhead > 0 && (
                <span className="workspace-branch-ahead flex items-center gap-0.5">
                  <ArrowUp className="h-2.5 w-2.5" />
                  {totalAhead}
                </span>
              )}
              {totalBehind > 0 && (
                <span className="workspace-branch-behind flex items-center gap-0.5">
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

function WorkspaceTabSwitcher() {
  const navigate = useNavigate();
  const { projectId, project } = useProject();
  const { activeWorktreeId, activeTaskId, setActiveWorktree } = useWorktree();
  const { rightSession } = useKanbanSessionContext();
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const { data: repos } = useProjectRepos(projectId);
  const { worktrees } = useProjectWorktrees(projectId);
  const { activeTab, setActiveTab } = useLayoutStore();
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const preferredWorkspaceBranch = useMemo(() => {
    const repoBranch =
      repos
        ?.map((repo) => repo.default_target_branch?.trim().toLowerCase() ?? '')
        .find((branch) => branch.length > 0) ?? null;

    if (repoBranch) {
      return repoBranch;
    }

    const projectBranch = project?.default_main_branch?.trim().toLowerCase();
    return projectBranch && projectBranch.length > 0 ? projectBranch : null;
  }, [project?.default_main_branch, repos]);

  const resolveFallbackWorktree = useCallback(() => {
    const currentWorktree =
      worktrees.find(
        (worktree) => worktree.workspace.id === activeWorktreeId
      ) ?? null;
    if (currentWorktree) {
      return currentWorktree;
    }

    if (preferredWorkspaceBranch) {
      const preferredWorktree = worktrees.find((worktree) =>
        matchesBranch(worktree.workspace.branch, preferredWorkspaceBranch)
      );
      if (preferredWorktree) {
        return preferredWorktree;
      }
    }

    const mainlineWorktree = worktrees.find((worktree) =>
      isMainlineBranch(worktree.workspace.branch)
    );
    return mainlineWorktree ?? worktrees[0] ?? null;
  }, [activeWorktreeId, preferredWorkspaceBranch, worktrees]);

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
        navigate(paths.projectSessions(projectId));
        return;
      }

      const navigateToFallbackWorkspace = () => {
        const fallbackWorktree = resolveFallbackWorktree();
        const targetAttemptId =
          activeWorktreeId ?? fallbackWorktree?.workspace.id ?? null;
        const targetTaskId =
          activeTaskId ?? fallbackWorktree?.workspace.task_id ?? null;

        if (targetAttemptId) {
          setActiveWorktree(targetAttemptId, targetTaskId);
        }

        if (targetAttemptId) {
          navigate(paths.projectWorkspace(projectId, targetAttemptId));
          return;
        }

        // No workspace entity yet: keep workspace tab active and fall back to
        // project root directory context.
        setActiveWorktree(null, null);
        navigate(paths.projectSessions(projectId));
      };

      if (effectiveActiveTab === 'kanban' && rightSession) {
        navigate(
          paths.projectSession(
            projectId,
            rightSession.workspaceId,
            rightSession.sessionId
          )
        );
        return;
      }

      navigateToFallbackWorkspace();
    },
    [
      activeTaskId,
      activeWorktreeId,
      effectiveActiveTab,
      navigate,
      projectId,
      rightSession,
      resolveFallbackWorktree,
      setActiveTab,
      setActiveWorktree,
    ]
  );

  return (
    <div className="workspace-tab-switcher flex h-7 items-center gap-0.5 rounded-md p-0.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = effectiveActiveTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => handleTabSelect(tab.key)}
            className={cn(
              'workspace-tab-button flex h-6 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
              isActive && 'is-active'
            )}
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
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const navigate = useNavigate();
  const { projectId, project } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { rightSession } = useKanbanSessionContext();
  const { projects } = useProjects();
  const handleOpenInEditor = useOpenProjectInEditor(project || null);
  const { data: repos } = useProjectRepos(projectId);
  const isSingleRepoProject = repos?.length === 1;
  const switchProject = useProjectSwitcher();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const isWorkspaceTab = effectiveActiveTab === 'workspace';

  const {
    toggleRightPanel,
    isRightPanelVisible,
    resetLayout,
    isEditorAreaVisible,
    toggleEditorArea,
  } = useLayoutStore();

  const { toggleFileTree, openNewTerminal, isPanelOpen } = usePanelActions();
  const recentProjects = useMemo(
    () => projects.slice(0, RECENT_PROJECT_MENU_LIMIT),
    [projects]
  );
  const isTerminalOpen = isPanelOpen(PANEL_IDS.TERMINAL);

  const handleCreateSession = () => {
    if (!projectId) return;

    if (isWorkspaceTab) {
      const targetWorkspaceId =
        workspaceId ?? activeWorktreeId ?? rightSession?.workspaceId;
      if (targetWorkspaceId) {
        navigate(
          `${paths.projectWorkspace(projectId, targetWorkspaceId)}?newSession=1`
        );
        return;
      }
    }

    navigate(`${paths.projectSessions(projectId)}?createSession=1`);
  };

  const handleOpenInIDE = () => {
    handleOpenInEditor();
  };

  const handleOpenSettings = useCallback(() => {
    settingsWindowApi.open();
  }, []);

  const handleOpenHome = useCallback(() => {
    navigate(paths.projects());
  }, [navigate]);

  const handleSwitchProject = useCallback(
    (nextProjectId: string) => {
      switchProject(nextProjectId, paths.projectSessions(nextProjectId));
    },
    [switchProject]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="workspace-topbar w-full px-1.5">
        <div className="relative flex items-center h-9 gap-0.5">
          <div className="flex items-center shrink-0 min-w-0">
            <ProjectRailToggleButton />
            {isWorkspaceTab ? <WorktreeSelector /> : null}
          </div>

          {workspaceId && <BranchStatusBadge workspaceId={workspaceId} />}

          <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <div className="pointer-events-auto">
              <WorkspaceTabSwitcher />
            </div>
          </div>

          <div className="ml-auto flex items-center shrink-0 gap-0.5">
            <div
              className={cn(
                'flex items-center gap-0.5',
                !isWorkspaceTab && 'invisible pointer-events-none'
              )}
              aria-hidden={!isWorkspaceTab}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="workspace-toolbar-button h-7 w-7"
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
                    className="workspace-toolbar-button h-7 w-7"
                    onClick={toggleEditorArea}
                    aria-label={
                      isEditorAreaVisible
                        ? '隐藏编辑区和终端区'
                        : '显示编辑区和终端区'
                    }
                    aria-pressed={isEditorAreaVisible}
                    tabIndex={isWorkspaceTab ? 0 : -1}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isEditorAreaVisible
                    ? '隐藏编辑区和终端区'
                    : '显示编辑区和终端区'}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="workspace-toolbar-button h-7 w-7"
                    onClick={openNewTerminal}
                    aria-label="Toggle terminal"
                    aria-pressed={isTerminalOpen}
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
                    className="workspace-toolbar-button h-7 w-7"
                    aria-pressed={isRightPanelVisible}
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
                    className="workspace-toolbar-button h-7 w-7"
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

            {projectId && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      onClick={handleCreateSession}
                      aria-label="Create new session"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New Session</TooltipContent>
                </Tooltip>
                {isSingleRepoProject && (
                  <OpenInIdeButton
                    onClick={handleOpenInIDE}
                    className="workspace-toolbar-button h-7 w-7"
                  />
                )}
                <ToolbarDivider />
              </>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="workspace-toolbar-button h-7 w-7"
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
                <button
                  type="button"
                  className="workspace-toolbar-button flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="返回首页或打开最近项目"
                  title="返回首页或打开最近项目"
                >
                  <Logo showText={false} size="window" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleOpenHome}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  回到首页
                </DropdownMenuItem>
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  最近项目
                </div>
                {recentProjects.length > 0 ? (
                  recentProjects.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => handleSwitchProject(item.id)}
                      title={item.name}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      <span className="truncate">{item.name}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>暂无最近项目</DropdownMenuItem>
                )}
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
