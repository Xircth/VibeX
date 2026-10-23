import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { sessionsApi, useOpenSettings } from '@/lib/api';
import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  startTransition,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
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
import {
  preserveCreateSessionQuery,
  resolveWorkspaceTabNavigation,
} from '@/lib/createSessionHref';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { HomeLogoMenu } from '@/components/layout/HomeLogoMenu';
import { paths } from '@/lib/paths';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useOpenProjectInEditor } from '@/hooks/useOpenProjectInEditor';
import { OpenInIdeButton } from '@/components/ide/OpenInIdeButton';
import { useLocalDesktopHost } from '@/lib/desktopShell';
import { useProjectRepos } from '@/hooks';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { PANEL_IDS, useLayoutStore } from '@/stores/useLayoutStore';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import type { WorkspaceTab } from '@/stores/useLayoutStore';
import { fallbackWorkspaceTab, pluginSurfaceId } from '@/lib/hostSurfaceIds';
import { parkNativeSurfaceThen } from '@/lib/nativeSurfaceHandoff';
import { useKanbanViews } from '@/hooks/useKanbanViews';
import { usePanelActions } from '@/hooks/usePanelActions';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { shouldShowKanbanMonitor } from '@/lib/kanbanZoneVisibility';
import {
  toggleKanbanCanvasListVisible,
  useKanbanCanvasListVisible,
} from '@/lib/kanbanCanvasListVisible';
import { cn } from '@/lib/utils';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import {
  resolveDefaultProjectWorkspace,
  shouldBindDefaultGitWorkspace,
} from '@/lib/workspaceDefault';
import { WorktreeSelector } from '@/components/layout/WorktreeSelector';
import { useSlotContributions, useViews } from '@vibex/plugin-sdk';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { Slot } from '@/components/plugins/Slot';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { logoLeadsWindowChrome } from '@/utils/platform';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
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

function WindowChromeLeadingRule() {
  return (
    <div
      className="window-chrome-leading-rule workspace-toolbar-divider mx-1 h-6 w-px"
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
  const { monitorSessions } = useKanbanSessionContext();
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
  const monitorVisible = shouldShowKanbanMonitor(
    isKanbanMonitorVisible,
    monitorSessions.length
  );

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
            aria-pressed={monitorVisible}
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
    </div>
  );
}

export function WorkspaceLayoutToggles() {
  const { t } = useTranslation('panels');
  const {
    toggleRightPanel,
    isRightPanelVisible,
    resetLayout,
    isEditorAreaVisible,
    toggleEditorArea,
  } = useLayoutStore();
  const { toggleFileTree, openNewTerminal, isPanelOpen } = usePanelActions();
  const isTerminalOpen = isPanelOpen(PANEL_IDS.TERMINAL);

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="workspace-toolbar-button h-7 w-7"
            onClick={toggleFileTree}
            aria-label={t('toolbar.toggleFileTree')}
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
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('toolbar.resetLayout')}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

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
  const { project } = useProject();
  const boardStyle = useKanbanBoardStyle();
  const showCanvasListToggle = !isWorkspaceTab && boardStyle === 'canvas';
  const isGitProject = Boolean(project?.is_git);

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2"
      role="group"
      aria-label="Workspace and target branches"
    >
      {showCanvasListToggle ? <CanvasSessionListToggleButton /> : null}
      {isWorkspaceTab && isGitProject ? <WorktreeSelector /> : null}
      {workspaceId && isGitProject ? (
        <BranchStatusBadge workspaceId={workspaceId} />
      ) : null}
    </div>
  );
}

function WorkspaceTabSwitcher() {
  const { t } = useTranslation('panels');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projectId, project } = useProject();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { rightSession } = useKanbanSessionContext();
  const lastRoute = useWindowProjectsStore((state) =>
    projectId ? (state.lastRouteByProject[projectId] ?? null) : null
  );
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const { data: repos } = useProjectRepos(projectId);
  const { worktrees, isLoading: isLoadingWorktrees } =
    useProjectWorktrees(projectId);
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { activeTab, setActiveTab } = useLayoutStore();
  const { setChromeOccluded, waitForOverlayReady } = useWorkspaceOverlay();
  const pluginTabs = usePluginHostContributions('app_tab');
  const sdkViews = useViews();
  const kanbanViews = useKanbanViews();
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const tabs: {
    key: WorkspaceTab;
    label: string;
    icon: typeof LayoutDashboard;
  }[] = useMemo(() => {
    const seen = new Set<string>();
    const pluginTabItems: {
      key: WorkspaceTab;
      label: string;
      icon: typeof LayoutDashboard;
    }[] = [];
    for (const item of pluginTabs) {
      const key = pluginSurfaceId(item.pluginId, item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      pluginTabItems.push({
        key,
        label: item.label,
        icon: contributionIconComponent(
          contributionMetadata(item).icon,
          Puzzle
        ),
      });
    }
    for (const view of sdkViews) {
      if (view.kind !== 'tab') continue;
      const pluginId = view.pluginId ?? 'plugin';
      const rawId = view.id.startsWith(`${pluginId}:`)
        ? view.id.slice(pluginId.length + 1)
        : view.id;
      const key = pluginSurfaceId(pluginId, rawId);
      if (seen.has(key)) continue;
      seen.add(key);
      pluginTabItems.push({
        key,
        label: view.title,
        icon: contributionIconComponent(view.icon, Puzzle),
      });
    }
    return [
      ...(kanbanViews.length > 0
        ? [
            {
              key: 'kanban' as WorkspaceTab,
              label: t('toolbar.kanban'),
              icon: LayoutDashboard,
            },
          ]
        : []),
      {
        key: 'workspace' as WorkspaceTab,
        label: t('toolbar.workspace'),
        icon: Monitor,
      },
      ...pluginTabItems,
    ];
  }, [kanbanViews.length, pluginTabs, sdkViews, t]);
  const availableTabKeys = tabs.map((tab) => tab.key);
  const resolvedActiveTab = fallbackWorkspaceTab(activeTab, availableTabKeys);
  useEffect(() => {
    if (resolvedActiveTab !== activeTab) {
      setActiveTab(resolvedActiveTab);
    }
  }, [activeTab, resolvedActiveTab, setActiveTab]);
  const effectiveActiveTab = routeTab ?? resolvedActiveTab;
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

  const bindWorkspaceLanding = useCallback(
    (href: string, workspaceIdToBind: string, taskId: string | null) => {
      setActiveWorktree(workspaceIdToBind, taskId);
      navigate(preserveCreateSessionQuery(href, searchParams));
    },
    [navigate, searchParams, setActiveWorktree]
  );

  const bindDefaultGitWorkspace = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const restored = resolveWorkspaceTabNavigation({
      projectId,
      lastRoute,
      rightSession,
    });
    if (restored) {
      bindWorkspaceLanding(
        restored.href,
        restored.workspaceId,
        restored.taskId
      );
      return;
    }

    const fallbackWorktree = resolveFallbackWorktree();
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

    const landed = resolveWorkspaceTabNavigation({
      projectId,
      lastRoute,
      rightSession,
      fallbackWorkspaceId: targetWorkspace?.id ?? null,
      fallbackTaskId: targetWorkspace?.task_id ?? null,
    });
    if (landed) {
      bindWorkspaceLanding(landed.href, landed.workspaceId, landed.taskId);
      return;
    }

    setActiveWorktree(null, null);
    navigate(
      preserveCreateSessionQuery(paths.projectSessions(projectId), searchParams)
    );
  }, [
    activeWorktreeId,
    bindWorkspaceLanding,
    currentProjectBranch,
    lastRoute,
    navigate,
    projectId,
    resolveFallbackWorktree,
    rightSession,
    searchParams,
    setActiveWorktree,
  ]);

  const defaultGitWorkspaceBindRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !shouldBindDefaultGitWorkspace({
        isWorkspaceSurface: effectiveActiveTab === 'workspace',
        routeWorkspaceId: workspaceId,
        routeSessionId: sessionId,
      })
    ) {
      return;
    }
    if (!useWindowProjectsStore.persist.hasHydrated()) {
      return useWindowProjectsStore.persist.onFinishHydration(() => {
        if (defaultGitWorkspaceBindRef.current === projectId) {
          return;
        }
        defaultGitWorkspaceBindRef.current = projectId ?? null;
        void bindDefaultGitWorkspace();
      });
    }
    const restored = resolveWorkspaceTabNavigation({
      projectId: projectId ?? '',
      lastRoute,
      rightSession,
    });
    if (!restored && isLoadingWorktrees) {
      return;
    }
    if (defaultGitWorkspaceBindRef.current === projectId) {
      return;
    }
    defaultGitWorkspaceBindRef.current = projectId ?? null;
    void bindDefaultGitWorkspace();
  }, [
    bindDefaultGitWorkspace,
    effectiveActiveTab,
    isLoadingWorktrees,
    lastRoute,
    projectId,
    rightSession,
    sessionId,
    workspaceId,
  ]);

  const handleTabSelect = useCallback(
    (tab: WorkspaceTab) => {
      const commit = () => {
        if (!projectId) {
          startTransition(() => {
            setActiveTab(tab);
          });
          return;
        }

        if (tab !== 'workspace') {
          startTransition(() => {
            setActiveTab(tab);
            navigate(paths.projectSessions(projectId));
          });
          return;
        }

        const fallbackWorktree = resolveFallbackWorktree();
        const immediateTarget = resolveWorkspaceTabNavigation({
          projectId,
          rightSession: effectiveActiveTab === 'kanban' ? rightSession : null,
          fallbackWorkspaceId: fallbackWorktree?.workspace.id ?? null,
          fallbackTaskId: fallbackWorktree?.workspace.task_id ?? null,
        });
        if (immediateTarget) {
          startTransition(() => {
            setActiveTab(tab);
            setActiveWorktree(
              immediateTarget.workspaceId,
              immediateTarget.taskId
            );
            navigate(immediateTarget.href);
          });
          return;
        }

        startTransition(() => {
          setActiveTab(tab);
        });

        void bindDefaultGitWorkspace();
      };

      void parkNativeSurfaceThen({
        park: tab !== 'workspace',
        occlude: () => setChromeOccluded(true),
        waitUntilParked: waitForOverlayReady,
        commit,
      });
    },
    [
      bindDefaultGitWorkspace,
      effectiveActiveTab,
      navigate,
      projectId,
      rightSession,
      resolveFallbackWorktree,
      setActiveTab,
      setActiveWorktree,
      setChromeOccluded,
      waitForOverlayReady,
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
            data-basic-guide={
              tab.key === 'kanban'
                ? 'toolbar-kanban'
                : tab.key === 'workspace'
                  ? 'toolbar-workspace'
                  : undefined
            }
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId, project } = useProject();
  const handleOpenInEditor = useOpenProjectInEditor(project || null);
  const { data: repos } = useProjectRepos(projectId);
  const isSingleRepoProject = repos?.length === 1;
  const localDesktopHost = useLocalDesktopHost();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const isWorkspaceTab = effectiveActiveTab === 'workspace';
  const boardStyle = useKanbanBoardStyle();
  const hasLeadingControls = isWorkspaceTab || boardStyle === 'canvas';
  const showLayoutToggles = isWorkspaceTab || boardStyle !== 'canvas';
  const logoLeads = logoLeadsWindowChrome();

  const toolbarItems = usePluginHostContributions('toolbar');
  const sdkToolbarSlots = useSlotContributions('toolbar.actions');
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const mergedToolbarActions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{
      key: string;
      title: string;
      icon: ReturnType<typeof contributionIconComponent>;
      onSelect: () => void;
    }> = [];
    for (const slotItem of sdkToolbarSlots) {
      if (slotItem.component || slotItem.render) continue;
      const pluginId = slotItem.pluginId ?? 'plugin';
      const key = `${pluginId}:${slotItem.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        key,
        title: slotItem.tooltip ?? slotItem.label ?? slotItem.id,
        icon: contributionIconComponent(slotItem.icon),
        onSelect: () => {
          if (slotItem.onActivate) {
            void Promise.resolve(slotItem.onActivate()).catch(() => undefined);
          } else {
            void pluginApi.invokeContribution(pluginId, slotItem.id);
          }
        },
      });
    }
    for (const item of toolbarItems) {
      const key = `${item.pluginId}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata = contributionMetadata(item);
      const title = String(metadata.title ?? item.label);
      const handler =
        typeof metadata.handler === 'string' ? metadata.handler : item.id;
      list.push({
        key,
        title,
        icon: contributionIconComponent(metadata.icon),
        onSelect: () => {
          void pluginApi.invokeContribution(item.pluginId, handler);
        },
      });
    }
    return list;
  }, [pluginApi, sdkToolbarSlots, toolbarItems]);
  const visibleToolbar = mergedToolbarActions.slice(0, 4);
  const overflowToolbar = mergedToolbarActions.slice(4);

  const handleCreateSession = () => {
    if (!projectId) return;

    requestCreateSessionInExecutionArea(setSearchParams, searchParams);
  };

  const handleOpenInIDE = () => {
    handleOpenInEditor();
  };

  const handleOpenSettings = useOpenSettings();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="workspace-topbar window-chrome relative w-full px-1.5">
        <div data-tauri-drag-region className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="pointer-events-auto">
            <WorkspaceTabSwitcher />
          </div>
        </div>
        <div
          data-tauri-drag-region
          className="relative z-10 flex h-9 items-center gap-0.5"
        >
          {logoLeads ? <HomeLogoMenu align="start" /> : null}
          {hasLeadingControls ? <WindowChromeLeadingRule /> : null}
          <WorkspaceBranchControls
            isWorkspaceTab={isWorkspaceTab}
            workspaceId={workspaceId}
          />

          <div className="ml-auto flex items-center shrink-0 gap-0.5">
            {isWorkspaceTab ? (
              <WorkspaceLayoutToggles />
            ) : (
              <KanbanLayoutToggles />
            )}
            {showLayoutToggles ? <ToolbarDivider /> : null}
            <Slot name="toolbar.actions" />
            {visibleToolbar.map((item) => {
              const Icon = item.icon;
              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="workspace-toolbar-button h-7 w-7"
                      aria-label={item.title}
                      onClick={item.onSelect}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{item.title}</TooltipContent>
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
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem
                        key={item.key}
                        className="gap-2"
                        onSelect={item.onSelect}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {item.title}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

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
                      data-basic-guide="toolbar-new-session"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New Session</TooltipContent>
                </Tooltip>
                {isSingleRepoProject && localDesktopHost ? (
                  <OpenInIdeButton
                    onClick={handleOpenInIDE}
                    className="workspace-toolbar-button h-7 w-7"
                  />
                ) : null}
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
                  data-basic-guide="open-settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Settings</TooltipContent>
            </Tooltip>

            {logoLeads ? null : <HomeLogoMenu align="end" />}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
