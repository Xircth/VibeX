import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { sessionsApi, settingsWindowApi } from '@/lib/api';
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
  List,
  Columns2,
  MessagesSquare,
  Monitor,
  Puzzle,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Logo } from '@/components/Logo';
import {
  resolveCreateSessionHref,
  resolveWorkspaceTabNavigation,
} from '@/lib/createSessionHref';
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
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import {
  toggleKanbanCanvasListVisible,
  useKanbanCanvasListVisible,
} from '@/lib/kanbanCanvasListVisible';
import { cn } from '@/lib/utils';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { resolveDefaultProjectWorkspace } from '@/lib/workspaceDefault';
import { WorktreeSelector } from '@/components/layout/WorktreeSelector';
import { ProjectRailToggleButton } from '@/components/layout/ProjectRailToggleButton';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { MoreHorizontal } from 'lucide-react';

function ToolbarDivider() {
  return (
    <div
      className="workspace-toolbar-divider mx-1 h-6 w-px"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

function CanvasSessionListToggleButton() {
  const { t } = useTranslation('panels');
  const listVisible = useKanbanCanvasListVisible();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => toggleKanbanCanvasListVisible()}
      aria-label={
        listVisible ? t('canvasSessionList.hide') : t('canvasSessionList.show')
      }
      aria-pressed={listVisible}
      title={
        listVisible ? t('canvasSessionList.hide') : t('canvasSessionList.show')
      }
    >
      <List className="h-4 w-4" />
    </Button>
  );
}

export function KanbanLayoutToggles() {
  const { t } = useTranslation('panels');
  const boardStyle = useKanbanBoardStyle();
  const isKanbanListVisible = useLayoutStore(
    (state) => state.isKanbanListVisible
  );
  const isKanbanMonitorVisible = useLayoutStore(
    (state) => state.isKanbanMonitorVisible
  );
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const toggleKanbanList = useLayoutStore((state) => state.toggleKanbanList);
  const toggleKanbanMonitor = useLayoutStore(
    (state) => state.toggleKanbanMonitor
  );
  const toggleKanbanSession = useLayoutStore(
    (state) => state.toggleKanbanSession
  );
  const resetKanbanLayout = useLayoutStore((state) => state.resetKanbanLayout);

  if (boardStyle === 'canvas') {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="workspace-toolbar-button h-7 w-7"
            onClick={toggleKanbanList}
            aria-label={t('toolbar.toggleSessionList')}
            aria-pressed={isKanbanListVisible}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('toolbar.toggleSessionList')}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="workspace-toolbar-button h-7 w-7"
            onClick={toggleKanbanMonitor}
            aria-label={t('toolbar.toggleSessionMonitor')}
            aria-pressed={isKanbanMonitorVisible}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('toolbar.toggleSessionMonitor')}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="workspace-toolbar-button h-7 w-7"
            onClick={toggleKanbanSession}
            aria-label={t('toolbar.toggleSessionExecution')}
            aria-pressed={isKanbanSessionVisible}
          >
            <MessagesSquare className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('toolbar.toggleSessionExecution')}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="workspace-toolbar-button h-7 w-7"
            onClick={resetKanbanLayout}
            aria-label={t('toolbar.resetKanbanLayout')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('toolbar.resetKanbanLayout')}
        </TooltipContent>
      </Tooltip>

      <ToolbarDivider />
    </div>
  );
}

const RECENT_PROJECT_MENU_LIMIT = 6;

export function BranchStatusBadge({ workspaceId }: { workspaceId: string }) {
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
        <div className="workspace-branch-status-badge raised-control flex h-7 items-center gap-1 rounded-lg px-2 text-xs">
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

export function WorkspaceBranchControls({
  isWorkspaceTab,
  workspaceId,
}: {
  isWorkspaceTab: boolean;
  workspaceId?: string;
}) {
  const boardStyle = useKanbanBoardStyle();
  const showCanvasListToggle = !isWorkspaceTab && boardStyle === 'canvas';

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2"
      role="group"
      aria-label="Workspace and target branches"
    >
      <ProjectRailToggleButton />
      {showCanvasListToggle ? <CanvasSessionListToggleButton /> : null}
      {isWorkspaceTab ? <WorktreeSelector /> : null}
      {workspaceId ? <BranchStatusBadge workspaceId={workspaceId} /> : null}
    </div>
  );
}

function WorkspaceTabSwitcher() {
  const { t } = useTranslation('panels');
  const navigate = useNavigate();
  const { projectId, project } = useProject();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { rightSession } = useKanbanSessionContext();
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const { data: repos } = useProjectRepos(projectId);
  const { worktrees } = useProjectWorktrees(projectId);
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
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

  const currentProjectBranch =
    primaryRepoBranches.find((branch) => branch.is_current)?.name ??
    preferredWorkspaceBranch;

  const resolveFallbackWorktree = useCallback(() => {
    const currentWorktree =
      worktrees.find(
        (worktree) => worktree.workspace.id === activeWorktreeId
      ) ?? null;
    if (currentWorktree) {
      return currentWorktree;
    }

    const selected = resolveDefaultProjectWorkspace({
      workspaces: worktrees.map((item) => item.workspace),
      currentBranch: currentProjectBranch,
    });
    if (!selected) {
      return null;
    }
    return worktrees.find((item) => item.workspace.id === selected.id) ?? null;
  }, [activeWorktreeId, currentProjectBranch, worktrees]);

  const tabs: {
    key: WorkspaceTab;
    label: string;
    icon: typeof LayoutDashboard;
  }[] = [
    { key: 'kanban', label: t('toolbar.kanban'), icon: LayoutDashboard },
    { key: 'workspace', label: t('toolbar.workspace'), icon: Monitor },
  ];

  const handleTabSelect = useCallback(
    (tab: WorkspaceTab) => {
      setActiveTab(tab);
      if (!projectId) return;

      if (tab === 'kanban') {
        navigate(paths.projectSessions(projectId));
        return;
      }

      const fallbackWorktree = resolveFallbackWorktree();
      const immediateTarget = resolveWorkspaceTabNavigation({
        projectId,
        rightSession:
          effectiveActiveTab === 'kanban' ? rightSession : null,
        fallbackWorkspaceId: fallbackWorktree?.workspace.id ?? null,
        fallbackTaskId: fallbackWorktree?.workspace.task_id ?? null,
      });
      if (immediateTarget) {
        setActiveWorktree(immediateTarget.workspaceId, immediateTarget.taskId);
        navigate(immediateTarget.href);
        return;
      }

      const navigateToFallbackWorkspace = async () => {
        let targetWorkspace = fallbackWorktree?.workspace ?? null;
        if (
          !targetWorkspace ||
          (targetWorkspace.use_worktree && !activeWorktreeId)
        ) {
          try {
            targetWorkspace = await sessionsApi.ensureProjectWorkspace({
              project_id: projectId,
              branch: currentProjectBranch ?? null,
            });
          } catch {
            // Keep any existing fallback workspace if the project root
            // cannot be created yet.
          }
        }

        const targetAttemptId = targetWorkspace?.id ?? null;
        const targetTaskId = targetWorkspace?.task_id ?? null;

        if (targetAttemptId) {
          setActiveWorktree(targetAttemptId, targetTaskId);
          navigate(paths.projectWorkspace(projectId, targetAttemptId));
          return;
        }

        setActiveWorktree(null, null);
        navigate(paths.projectSessions(projectId));
      };

      void navigateToFallbackWorkspace();
    },
    [
      activeWorktreeId,
      currentProjectBranch,
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
  const { t } = useTranslation(['panels', 'common']);
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
  const toolbarItems = usePluginHostContributions('toolbar');
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const visibleToolbar = toolbarItems.slice(0, 4);
  const overflowToolbar = toolbarItems.slice(4);

  const handleCreateSession = () => {
    if (!projectId) return;

    if (!isWorkspaceTab) {
      useLayoutStore.getState().setKanbanSessionVisible(true);
    }

    navigate(
      resolveCreateSessionHref({
        projectId,
        isWorkspaceTab,
        workspaceId,
        activeWorktreeId,
        rightSessionWorkspaceId: rightSession?.workspaceId,
      })
    );
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
          <WorkspaceBranchControls
            isWorkspaceTab={isWorkspaceTab}
            workspaceId={workspaceId}
          />

          <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <div className="pointer-events-auto">
              <WorkspaceTabSwitcher />
            </div>
          </div>

          <div className="ml-auto flex items-center shrink-0 gap-0.5">
            {visibleToolbar.map((item) => {
              const metadata = contributionMetadata(item);
              const title = String(metadata.title ?? item.label);
              const handler =
                typeof metadata.handler === 'string'
                  ? metadata.handler
                  : item.id;
              return (
                <Tooltip key={`${item.pluginId}:${item.id}`}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      aria-label={title}
                      onClick={() =>
                        void pluginApi.invokeContribution(
                          item.pluginId,
                          handler
                        )
                      }
                    >
                      <Puzzle className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{title}</TooltipContent>
                </Tooltip>
              );
            })}
            {overflowToolbar.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="workspace-toolbar-button h-7 w-7"
                    aria-label={t('common:more')}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {overflowToolbar.map((item) => {
                    const metadata = contributionMetadata(item);
                    const title = String(metadata.title ?? item.label);
                    const handler =
                      typeof metadata.handler === 'string'
                        ? metadata.handler
                        : item.id;
                    return (
                      <DropdownMenuItem
                        key={`${item.pluginId}:${item.id}`}
                        onSelect={() =>
                          void pluginApi.invokeContribution(
                            item.pluginId,
                            handler
                          )
                        }
                      >
                        {title}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {isWorkspaceTab ? (
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      onClick={toggleFileTree}
                      aria-label={t('toolbar.toggleFileTree')}
                      tabIndex={isWorkspaceTab ? 0 : -1}
                    >
                      <FolderTree className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('toolbar.toggleFileTree')}
                  </TooltipContent>
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
                          ? t('toolbar.hideEditorAndTerminal')
                          : t('toolbar.showEditorAndTerminal')
                      }
                      aria-pressed={isEditorAreaVisible}
                      tabIndex={isWorkspaceTab ? 0 : -1}
                    >
                      <Code2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isEditorAreaVisible
                      ? t('toolbar.hideEditorAndTerminal')
                      : t('toolbar.showEditorAndTerminal')}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      onClick={openNewTerminal}
                      aria-label={t('toolbar.toggleTerminal')}
                      aria-pressed={isTerminalOpen}
                      tabIndex={isWorkspaceTab ? 0 : -1}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('toolbar.toggleTerminal')}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      aria-pressed={isRightPanelVisible}
                      onClick={toggleRightPanel}
                      aria-label={t('toolbar.toggleAiPanel')}
                      tabIndex={isWorkspaceTab ? 0 : -1}
                    >
                      {isRightPanelVisible ? (
                        <PanelRight className="h-3.5 w-3.5" />
                      ) : (
                        <PanelLeft className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('toolbar.toggleAiPanel')}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      onClick={resetLayout}
                      aria-label={t('toolbar.resetLayout')}
                      tabIndex={isWorkspaceTab ? 0 : -1}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('toolbar.resetLayout')}
                  </TooltipContent>
                </Tooltip>

                <ToolbarDivider />
              </div>
            ) : (
              <KanbanLayoutToggles />
            )}

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
                  aria-label={t('toolbar.homeOrRecentProjects')}
                  title={t('toolbar.homeOrRecentProjects')}
                >
                  <Logo showText={false} size="toolbar" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleOpenHome}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  {t('toolbar.backToHome')}
                </DropdownMenuItem>
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  {t('toolbar.recentProjects')}
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
                  <DropdownMenuItem disabled>
                    {t('toolbar.noRecentProjects')}
                  </DropdownMenuItem>
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
