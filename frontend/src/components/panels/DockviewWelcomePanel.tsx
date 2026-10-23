import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AppWindow,
  Bot,
  BriefcaseBusiness,
  FolderOpen,
  GitBranch,
  GitCompare,
  Loader2,
  Plus,
  Settings,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import {
  ProductContextMenu,
  type ProductContextMenuItem,
  useAppContextMenu,
} from '@/components/context-menu';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { resolveFileTreeAbsolutePath } from '@/components/file-tree/file-tree-utils';
import { useAttempt } from '@/hooks/useAttempt';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useProjectRepos } from '@/hooks/useProjectRepos';
import { useProjects } from '@/hooks/useProjects';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import {
  type KanbanProjectSessionRecord,
  useKanbanProjectSessions,
} from '@/hooks/useKanbanProjectSessions';
import { fileTreeApi, openSettingsSurface, projectsApi } from '@/lib/api';
import { openLocalAppWindow } from '@/lib/api/appWindow';
import { useTauriClient } from '@/lib/desktopShell';
import {
  importedProjectName,
  orderImportedProjects,
} from '@/lib/importedProject';
import { initProjectGitWithPrompt } from '@/lib/initProjectGit';
import { paths } from '@/lib/paths';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
} from '@/lib/projectDeleteUi';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';
import {
  flattenProjectTree,
  RecentProjectItem,
} from '@/components/welcome/RecentProjectItem';
import { WorkspaceSessionRow } from '@/components/workspace-session-list/WorkspaceSessionList';
import {
  pickRandomProjectRootFile,
  resolveWelcomeWorkspaceRootPath,
} from './welcomeRootFile';

const WELCOME_RECENT_SESSION_LIMIT = 4;
const WELCOME_RECENT_PROJECT_LIMIT = 5;
const DOCS_URL = 'https://vibex.com/docs';
const TIP_KEYS = [
  'projectFolder',
  'shareWindow',
  'stopShortcut',
  'mentionAgent',
  'neverShare',
] as const;

function WelcomeSection({
  title,
  headingId,
  children,
  className,
}: {
  title: string;
  headingId: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={className ?? 'workspace-welcome__section'}
      aria-labelledby={headingId}
    >
      <h2 id={headingId}>{title}</h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function WelcomeAction({
  icon: Icon,
  label,
  onClick,
  loading,
  guideId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  loading?: boolean;
  guideId?: string;
}) {
  const { t } = useTranslation(['app']);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      data-basic-guide={guideId}
      className="group flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      )}
      <span>{loading ? t('welcomePage.processing') : label}</span>
    </button>
  );
}

function WelcomeTips() {
  const { t } = useTranslation(['panels']);
  const [index, setIndex] = useState(0);
  const pausedRef = useRef(false);

  const show = useCallback((next: number) => {
    setIndex((next + TIP_KEYS.length) % TIP_KEYS.length);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!pausedRef.current) {
        setIndex((current) => (current + 1) % TIP_KEYS.length);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <footer
      className="workspace-welcome__tips"
      aria-label={t('welcomePanel.tipsAria')}
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
    >
      <div className="workspace-welcome__tips-main">
        <button
          type="button"
          className="workspace-welcome__tips-nav"
          aria-label={t('welcomePanel.tipsPrev')}
          onClick={() => show(index - 1)}
        >
          ‹
        </button>
        <p className="workspace-welcome__tips-text">
          {t(`welcomePanel.tips.${TIP_KEYS[index]}`)}
        </p>
        <div className="workspace-welcome__tips-dots">
          {TIP_KEYS.map((key, tipIndex) => (
            <button
              key={key}
              type="button"
              aria-label={t('welcomePanel.tipsDot', { index: tipIndex + 1 })}
              aria-current={tipIndex === index}
              onClick={() => show(tipIndex)}
            />
          ))}
        </div>
        <button
          type="button"
          className="workspace-welcome__tips-nav"
          aria-label={t('welcomePanel.tipsNext')}
          onClick={() => show(index + 1)}
        >
          ›
        </button>
      </div>
      <a
        className="workspace-welcome__tips-docs"
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
      >
        {t('welcomePanel.tipsDocs')}
      </a>
    </footer>
  );
}

type ProjectContextMenuState = {
  projectId: string;
  projectName: string;
  isGit: boolean;
  isHome: boolean;
  x: number;
  y: number;
};

function DockviewWelcomePanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'app', 'common']);
  const navigate = useNavigate();
  const navigateWithSearch = useNavigateWithSearch();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openSurfaceMenu } = useAppContextMenu();
  const {
    openDiffPreview,
    openFilePreview,
    openNewTerminal,
    openWebPreview,
    showFileTree,
  } = usePanelActionsContext();
  const { activateExecutionSession } = useKanbanSessionContext();
  const storedRootPath = useFileTreeStore((state) => state.rootPath);
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const { repos: workspaceRepos } = useAttemptRepo(
    activeWorktreeId ?? undefined
  );
  const { projectId } = useProject();
  const { data: projectRepos } = useProjectRepos(projectId);
  const { sessions, isLoading: isSessionsLoading } =
    useKanbanProjectSessions(projectId);
  const { projects, isLoading: isProjectsLoading } = useProjects();
  const switchProject = useProjectSwitcher();
  const tauriClient = useTauriClient();
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const [contextMenu, setContextMenu] =
    useState<ProjectContextMenuState | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);

  const recentSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.status !== 'archived')
        .slice(0, WELCOME_RECENT_SESSION_LIMIT),
    [sessions]
  );

  const recentProjects = useMemo(
    () =>
      flattenProjectTree(orderImportedProjects(projects)).slice(
        0,
        WELCOME_RECENT_PROJECT_LIMIT
      ),
    [projects]
  );

  const openBrowseFiles = useCallback(async () => {
    showFileTree();

    const workspaceRoot = resolveWelcomeWorkspaceRootPath({
      storedRootPath,
      workspace,
      workspaceRepos,
      projectRepoPath: projectRepos?.[0]?.path ?? null,
    });
    if (!workspaceRoot) {
      return;
    }

    try {
      const response = await fileTreeApi.listDirectoryChildren(
        workspaceRoot,
        ''
      );
      const relativePath = pickRandomProjectRootFile(
        response.files,
        response.gitignored_files
      );
      if (!relativePath) {
        return;
      }
      openFilePreview(resolveFileTreeAbsolutePath(workspaceRoot, relativePath));
    } catch {
      // The file tree is already open; skip preview if listing fails.
    }
  }, [
    openFilePreview,
    projectRepos,
    showFileTree,
    storedRootPath,
    workspace,
    workspaceRepos,
  ]);

  const handleCreateSession = useCallback(() => {
    requestCreateSessionInExecutionArea(setSearchParams, searchParams);
  }, [searchParams, setSearchParams]);

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  };

  const handleOpenFolder = async () => {
    const result = await ProjectFormDialog.show({
      autoOpenFolderPicker: true,
    });
    if (result?.status === 'saved' && result.project) {
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  };

  const handleCloneRepo = async () => {
    const result = await CloneRepoDialog.show();
    if (result.status !== 'cloned') {
      return;
    }
    const name = result.repo.display_name || result.repo.name;
    try {
      const project = await projectsApi.create({
        name,
        repositories: [{ display_name: name, git_repo_path: result.repo.path }],
      });
      switchProject(project.id, paths.projectSessions(project.id));
    } catch (error) {
      toast.error(
        t('app:welcomePage.createProjectFailed', { error: String(error) })
      );
    }
  };

  const handleProjectClick = useCallback(
    (nextProjectId: string) => {
      switchProject(nextProjectId, paths.projectSessions(nextProjectId));
    },
    [switchProject]
  );

  const handleProjectContextMenu = useCallback(
    (
      project: {
        id: string;
        name: string;
        is_git?: boolean;
        is_home?: boolean;
      },
      event: React.MouseEvent<HTMLButtonElement>
    ) => {
      event.preventDefault();
      setContextMenu({
        projectId: project.id,
        projectName: importedProjectName(project, (key) => t(`app:${key}`)),
        isGit: Boolean(project.is_git),
        isHome: Boolean(project.is_home),
        x: event.clientX,
        y: event.clientY,
      });
    },
    [t]
  );

  const handleOpenFromContextMenu = useCallback(() => {
    if (!contextMenu) {
      return;
    }
    handleProjectClick(contextMenu.projectId);
    setContextMenu(null);
  }, [contextMenu, handleProjectClick]);

  const handleDeleteFromContextMenu = useCallback(async () => {
    if (!contextMenu || isDeletingProject) {
      return;
    }

    const targetProject = {
      id: contextMenu.projectId,
      name: contextMenu.projectName,
    };
    setContextMenu(null);

    const result = await ConfirmDialog.show({
      title: t('app:welcomePage.deleteProjectConfirmTitle', {
        name: targetProject.name,
      }),
      message: t('app:welcomePage.deleteProjectConfirmMessage'),
      confirmText: t('app:welcomePage.confirmDelete'),
      cancelText: t('common:cancel'),
      contentClassName: PROJECT_DELETE_CONFIRM_CLASSNAME,
      contentStyle: PROJECT_DELETE_CONFIRM_STYLE,
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingProject(true);
    try {
      await projectsApi.delete(targetProject.id);
      toast.success(
        t('app:welcomePage.projectDeleted', { name: targetProject.name })
      );
    } catch (error) {
      console.error('Failed to delete recent project:', error);
      toast.error(t('app:welcomePage.deleteProjectFailed'));
    } finally {
      setIsDeletingProject(false);
    }
  }, [contextMenu, isDeletingProject, t]);

  const handleSessionClick = useCallback(
    (session: KanbanProjectSessionRecord) => {
      activateExecutionSession(session.placement);
      setActiveWorktree(session.workspace.id, session.taskId);
      if (projectId) {
        navigateWithSearch(
          paths.projectSession(projectId, session.workspace.id, session.id)
        );
      }
    },
    [activateExecutionSession, navigateWithSearch, projectId, setActiveWorktree]
  );

  const handleOpenSettings = useCallback(() => {
    openSettingsSurface(navigate);
  }, [navigate]);

  const handleOpenAgentSettings = useCallback(() => {
    openSettingsSurface(navigate, '/settings/agents');
  }, [navigate]);

  const handleOpenProjectRail = useCallback(() => {
    setRailVisible(true);
  }, [setRailVisible]);

  return (
    <div
      className="workspace-welcome h-full w-full overflow-auto"
      data-panel="welcome"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'files',
            label: t('common:contextMenu.openFiles'),
            onSelect: () => {
              void openBrowseFiles();
            },
          },
          {
            id: 'review',
            label: t('common:contextMenu.openReview'),
            onSelect: openDiffPreview,
          },
          {
            id: 'terminal',
            label: t('common:contextMenu.openTerminal'),
            onSelect: openNewTerminal,
          },
          {
            id: 'browser',
            label: t('common:contextMenu.openBrowser'),
            onSelect: openWebPreview,
          },
        ]);
      }}
    >
      <div className="workspace-welcome__inner">
        <WelcomeSection
          title={t('welcomePanel.resumeSessions')}
          headingId="welcome-resume-heading"
        >
          {isSessionsLoading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              {t('welcomePanel.loadingSessions')}
            </div>
          ) : recentSessions.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              {t('welcomePanel.noSessions')}
            </div>
          ) : (
            <TooltipProvider>
              <div className="workspace-session-list space-y-2" role="list">
                {recentSessions.map((session) => (
                  <WorkspaceSessionRow
                    key={session.id}
                    session={session}
                    isSelected={false}
                    onClick={() => handleSessionClick(session)}
                  />
                ))}
              </div>
            </TooltipProvider>
          )}
        </WelcomeSection>

        <div className="workspace-welcome__mid">
          <WelcomeSection
            title={t('welcomePanel.startSection')}
            headingId="welcome-start-heading"
          >
            <WelcomeAction
              icon={Plus}
              label={t('workspaceSessionList.newSession')}
              onClick={handleCreateSession}
            />
            <WelcomeAction
              icon={Plus}
              label={t('app:welcomePage.createNewProject')}
              onClick={() => {
                void handleCreateProject();
              }}
              guideId="welcome-create-project"
            />
            <WelcomeAction
              icon={FolderOpen}
              label={t('app:welcomePage.selectFolder')}
              onClick={() => {
                void handleOpenFolder();
              }}
              guideId="welcome-select-folder"
            />
            <WelcomeAction
              icon={GitBranch}
              label={t('app:welcomePage.cloneRepo')}
              onClick={() => {
                void handleCloneRepo();
              }}
            />
            {tauriClient ? (
              <WelcomeAction
                icon={AppWindow}
                label={t('app:welcomePage.newWindow')}
                onClick={openLocalAppWindow}
              />
            ) : null}
            <WelcomeAction
              icon={Settings}
              label={t('welcomePanel.openSettings')}
              onClick={handleOpenSettings}
              guideId="open-settings"
            />
          </WelcomeSection>

          <WelcomeSection
            title={t('welcomePanel.openProjects')}
            headingId="welcome-projects-heading"
          >
            {isProjectsLoading ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                {t('welcomePanel.loadingProjects')}
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                {t('welcomePanel.noProjects')}
              </div>
            ) : (
              recentProjects.map(({ project, depth }) => (
                <RecentProjectItem
                  key={project.id}
                  project={project}
                  depth={depth}
                  showPath={false}
                  onClick={() => handleProjectClick(project.id)}
                  onContextMenu={(event) => {
                    event.stopPropagation();
                    handleProjectContextMenu(project, event);
                  }}
                />
              ))
            )}
          </WelcomeSection>
        </div>

        <section
          className="workspace-welcome__recommend-wrap"
          aria-labelledby="welcome-recommend-heading"
        >
          <h2 id="welcome-recommend-heading">
            {t('welcomePanel.recommendSection')}
          </h2>
          <div className="workspace-welcome__recommend">
            <button
              type="button"
              className="workspace-welcome__action"
              onClick={openNewTerminal}
            >
              <span className="workspace-welcome__action-icon">
                <Terminal className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="workspace-welcome__action-title">
                  {t('welcomePanel.recommendTerminalTitle')}
                </span>
                <span className="workspace-welcome__action-description">
                  {t('welcomePanel.recommendTerminalDescription')}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="workspace-welcome__action"
              onClick={openDiffPreview}
            >
              <span className="workspace-welcome__action-icon">
                <GitCompare className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="workspace-welcome__action-title">
                  {t('welcomePanel.recommendDiffsTitle')}
                </span>
                <span className="workspace-welcome__action-description">
                  {t('welcomePanel.recommendDiffsDescription')}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="workspace-welcome__action"
              onClick={handleOpenProjectRail}
            >
              <span className="workspace-welcome__action-icon">
                <BriefcaseBusiness className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="workspace-welcome__action-title">
                  {t('welcomePanel.recommendProjectRailTitle')}
                </span>
                <span className="workspace-welcome__action-description">
                  {t('welcomePanel.recommendProjectRailDescription')}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="workspace-welcome__action"
              onClick={handleOpenAgentSettings}
            >
              <span className="workspace-welcome__action-icon">
                <Bot className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="workspace-welcome__action-title">
                  {t('welcomePanel.recommendAgentSettingsTitle')}
                </span>
                <span className="workspace-welcome__action-description">
                  {t('welcomePanel.recommendAgentSettingsDescription')}
                </span>
              </span>
            </button>
          </div>
        </section>

        <WelcomeTips />
      </div>

      {contextMenu ? (
        <ProductContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              id: 'open',
              label: t('app:welcomePage.open'),
              onSelect: handleOpenFromContextMenu,
            },
            ...(!contextMenu.isGit && !contextMenu.isHome
              ? [
                  {
                    id: 'init-git',
                    label: t('app:welcomePage.initGit'),
                    onSelect: () => {
                      const target = contextMenu;
                      setContextMenu(null);
                      void initProjectGitWithPrompt({
                        id: target.projectId,
                        name: target.projectName,
                        is_git: target.isGit,
                      });
                    },
                  } satisfies ProductContextMenuItem,
                ]
              : []),
            ...(!contextMenu.isHome
              ? [
                  {
                    id: 'delete',
                    label: t('app:welcomePage.confirmDelete'),
                    danger: true,
                    disabled: isDeletingProject,
                    onSelect: () => {
                      void handleDeleteFromContextMenu();
                    },
                  } satisfies ProductContextMenuItem,
                ]
              : []),
          ]}
        />
      ) : null}
    </div>
  );
}

export default DockviewWelcomePanel;
