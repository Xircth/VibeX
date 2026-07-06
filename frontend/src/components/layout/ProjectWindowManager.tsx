import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  attemptsApi,
  configApi,
  sessionsApi,
  type SessionSummary,
} from '@/lib/api';
import { showDesktopToast } from '@/lib/desktopToast';
import { paths } from '@/lib/paths';
import { tauriEmit, tauriListen } from '@/lib/tauriApi';
import { desktopApi } from '@/lib/api';
import { dateTimestamp } from '@/utils/date';
import {
  useWindowProjectsStore,
  type ProjectWindowTrackingState,
} from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useStopToastSuppression } from '@/stores/useTaskDetailsUiStore';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';

function getSessionStatusLabel(session: KanbanProjectSessionRecord) {
  if (session.isRunning) {
    return '运行中';
  }

  switch (session.status) {
    case 'done':
      return '已完成';
    case 'inreview':
      return '待检查';
    case 'inprogress':
      return '进行中';
    case 'todo':
      return '待开始';
    default:
      return '空闲';
  }
}

type ProjectSessionTarget = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
};

type ProjectRailNavigationTarget = {
  projectId: string;
  route: string;
};

type ProjectRailProjectDialogRequest = {
  mode: 'create' | 'open';
};

const PROJECT_WINDOW_TRACKING_EVENT = 'project-window-tracking-state';
const PROJECT_WINDOW_TRACKING_REQUEST_EVENT =
  'project-window-tracking-request';

function buildTrackedProjectIds(
  currentProjectId: string | undefined,
  openProjectIds: string[],
  projectsById: Record<string, { id: string }>,
  includeAllProjects: boolean
) {
  return Array.from(
    new Set([
      ...(currentProjectId ? [currentProjectId] : []),
      ...openProjectIds,
      ...(includeAllProjects ? Object.keys(projectsById) : []),
    ])
  ).filter((trackedProjectId) => Boolean(projectsById[trackedProjectId]));
}

function ProjectActivityTracker({
  projectId,
  isActive,
  enableNotifications = true,
}: {
  projectId: string;
  isActive: boolean;
  enableNotifications?: boolean;
}) {
  const navigate = useNavigate();
  const { config } = useUserSystem();
  const { projectsById } = useProjects();
  const { sessions, isLoading, workspacesWithStatus } =
    useKanbanProjectSessions(projectId);
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const setProjectSnapshot = useWindowProjectsStore(
    (state) => state.setProjectSnapshot
  );
  const setProjectAlert = useWindowProjectsStore(
    (state) => state.setProjectAlert
  );
  const markProjectAlertRead = useWindowProjectsStore(
    (state) => state.markProjectAlertRead
  );
  const requestProjectFocus = useWindowProjectsStore(
    (state) => state.requestProjectFocus
  );
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const projectAlert = useWindowProjectsStore(
    (state) => state.projectAlerts[projectId]
  );
  const setProjectActiveTab = useLayoutStore(
    (state) => state.setProjectActiveTab
  );
  const previousWorkspaceStateRef = useRef<
    Record<string, { running: boolean }>
  >({});
  const hasInitializedWorkspaceRef = useRef(false);
  const previousSnapshotSignatureRef = useRef<string>('');
  const { consumeStopToastSuppression } = useStopToastSuppression();

  const openProjectSession = useCallback(
    ({ projectId, workspaceId, sessionId }: ProjectSessionTarget) => {
      setRailVisible(true);
      ensureProjectOpen(projectId);
      requestProjectFocus(projectId, {
        workspaceId,
        sessionId,
        requestedAt: Date.now(),
      });
      setProjectActiveTab(projectId, 'kanban');
      navigate(paths.projectSession(projectId, workspaceId, sessionId));
    },
    [
      ensureProjectOpen,
      navigate,
      requestProjectFocus,
      setProjectActiveTab,
      setRailVisible,
    ]
  );

  const snapshot = useMemo(() => {
    const recentSessions = sessions.slice(0, 5).map((session) => {
      const visualState = session.isRunning
        ? 'loading'
        : session.isErrored
          ? 'error'
          : session.status === 'done' || session.status === 'inreview'
            ? 'success'
            : 'idle';

      return {
        sessionId: session.id,
        workspaceId: session.workspace.id,
        taskId: session.taskId,
        title: session.fullName,
        subtitle: session.workspaceDisplayLabel,
        statusLabel: getSessionStatusLabel(session),
        visualState,
        updatedAt: session.updatedAt,
      } as const;
    });

    return {
      isLoading,
      hasRunning: sessions.some((session) => session.isRunning),
      runningCount: sessions.filter((session) => session.isRunning).length,
      hasError: sessions.some((session) => session.isErrored),
      hasSessions: sessions.length > 0,
      recentSessions,
    };
  }, [isLoading, sessions]);

  useEffect(() => {
    const nextSignature = JSON.stringify(snapshot);
    if (previousSnapshotSignatureRef.current === nextSignature) {
      return;
    }

    previousSnapshotSignatureRef.current = nextSignature;
    ensureProjectOpen(projectId);
    setProjectSnapshot(projectId, snapshot);
  }, [ensureProjectOpen, projectId, setProjectSnapshot, snapshot]);

  useEffect(() => {
    if (isActive && projectAlert?.unread) {
      markProjectAlertRead(projectId);
      void attemptsApi.markSeen(projectAlert.workspaceId).catch(() => {
        // Ignore passive sync failures.
      });
    }
  }, [isActive, markProjectAlertRead, projectAlert, projectId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    tauriListen<ProjectSessionTarget>('desktop-toast-activated', (payload) => {
      if (payload.projectId !== projectId) {
        return;
      }

      openProjectSession(payload);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [openProjectSession, projectId]);

  const resolveSummaryDisplayName = useCallback((summary: SessionSummary) => {
    const manualName = summary.name?.trim();
    if (manualName) {
      return manualName;
    }

    const firstPrompt = summary.first_prompt?.replace(/\s+/g, ' ').trim() ?? '';
    if (firstPrompt.length > 0) {
      return Array.from(firstPrompt).slice(0, 6).join('');
    }

    return summary.display_name?.trim() || '会话';
  }, []);

  const isMainWindowCurrentlyFocused = useCallback(async () => {
    try {
      return await desktopApi.isMainWindowFocused();
    } catch {
      return (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        document.hasFocus()
      );
    }
  }, []);

  useEffect(() => {
    if (!enableNotifications) {
      return;
    }

    const currentWorkspaceStates = Object.fromEntries(
      workspacesWithStatus.map((workspace) => [
        workspace.id,
        {
          running: workspace.is_running,
        },
      ])
    );

    if (!hasInitializedWorkspaceRef.current) {
      previousWorkspaceStateRef.current = currentWorkspaceStates;
      hasInitializedWorkspaceRef.current = true;
      return;
    }

    let cancelled = false;

    workspacesWithStatus.forEach((workspace) => {
      const previousWorkspaceState =
        previousWorkspaceStateRef.current[workspace.id];
      if (!previousWorkspaceState?.running || workspace.is_running) {
        return;
      }

      void sessionsApi
        .getSummariesByWorkspace(workspace.id)
        .then(async (summaries) => {
          if (cancelled || summaries.length === 0) {
            return;
          }

          const latestSummary = [...summaries].sort(
            (left, right) =>
              dateTimestamp(right.updated_at) - dateTimestamp(left.updated_at)
          )[0];

          const kind = workspace.is_errored ? 'error' : 'success';
          const projectName = projectsById[projectId]?.name ?? '项目';
          const title =
            kind === 'error'
              ? `${projectName}：会话执行失败`
              : `${projectName}：会话已完成`;
          const sessionName = resolveSummaryDisplayName(latestSummary);
          const workspaceName =
            latestSummary.workspace_name ?? workspace.name ?? workspace.branch;
          const description = `${sessionName} · ${workspaceName}`;
          const windowFocused = await isMainWindowCurrentlyFocused();
          if (cancelled) {
            return;
          }
          const unread = !isActive || !windowFocused;

          setProjectAlert({
            projectId,
            workspaceId: workspace.id,
            sessionId: latestSummary.id,
            taskId: latestSummary.task_id,
            kind,
            unread,
            createdAt: latestSummary.updated_at,
            title,
            description,
          });

          if (consumeStopToastSuppression(workspace.id)) {
            return;
          }

          const shouldNotify = kind === 'error' || !windowFocused;
          if (!shouldNotify) {
            return;
          }

          if (config?.notifications.sound_enabled) {
            void configApi
              .playNotificationSound(config.notifications.sound_file)
              .catch((error) => {
                console.error(
                  'Failed to play session notification sound:',
                  error
                );
              });
          }

          if (!config?.notifications.push_enabled) {
            return;
          }

          void showDesktopToast({
            projectId,
            workspaceId: workspace.id,
            sessionId: latestSummary.id,
            title,
            description,
            kind,
            durationMs: 15000,
          }).catch((error) => {
            console.error(
              'Failed to show detached desktop toast window for session notification:',
              error
            );
          });
        })
        .catch((error) => {
          console.error(
            'Failed to load session summary for desktop toast notification:',
            error
          );
        });
    });

    previousWorkspaceStateRef.current = currentWorkspaceStates;
    return () => {
      cancelled = true;
    };
  }, [
    config?.notifications.push_enabled,
    config?.notifications.sound_enabled,
    config?.notifications.sound_file,
    consumeStopToastSuppression,
    enableNotifications,
    isMainWindowCurrentlyFocused,
    isActive,
    projectId,
    projectsById,
    resolveSummaryDisplayName,
    setProjectAlert,
    workspacesWithStatus,
  ]);

  return null;
}

export function ProjectWindowManager() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId } = useProject();
  const {
    projects,
    projectsById,
    isLoading: isProjectsLoading,
  } = useProjects();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const rememberProjectRoute = useWindowProjectsStore(
    (state) => state.rememberProjectRoute
  );
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const lastRouteByProject = useWindowProjectsStore(
    (state) => state.lastRouteByProject
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const pruneProjectState = useWindowProjectsStore(
    (state) => state.pruneProjectState
  );
  const replaceProjectTrackingState = useWindowProjectsStore(
    (state) => state.replaceProjectTrackingState
  );
  const isProjectRailWindow = location.pathname === '/project-rail';
  const isSettingsWindowRoute = location.pathname.startsWith('/settings');
  const shouldManageProjectWindows = !isSettingsWindowRoute;

  useEffect(() => {
    if (!shouldManageProjectWindows || !projectId) {
      return;
    }

    ensureProjectOpen(projectId);
    rememberProjectRoute(
      projectId,
      `${location.pathname}${location.search}${location.hash}`
    );
  }, [
    ensureProjectOpen,
    location.hash,
    location.pathname,
    location.search,
    projectId,
    rememberProjectRoute,
    shouldManageProjectWindows,
  ]);

  useEffect(() => {
    if (!shouldManageProjectWindows || isProjectsLoading) {
      return;
    }

    pruneProjectState(projects.map((project) => project.id));
  }, [
    isProjectsLoading,
    projects,
    pruneProjectState,
    shouldManageProjectWindows,
  ]);

  useEffect(() => {
    if (!shouldManageProjectWindows || isProjectRailWindow) {
      return;
    }

    void desktopApi
      .setProjectRailWindowVisible(railVisible, projects.length)
      .catch((error) => {
        console.error('Failed to sync project rail window visibility:', error);
      });
  }, [
    isProjectRailWindow,
    projects.length,
    railVisible,
    shouldManageProjectWindows,
  ]);

  const trackedProjectIds = useMemo(() => {
    if (!shouldManageProjectWindows || isProjectRailWindow) {
      return [];
    }

    return buildTrackedProjectIds(projectId, openProjectIds, projectsById, false);
  }, [
    isProjectRailWindow,
    openProjectIds,
    projectId,
    projectsById,
    shouldManageProjectWindows,
  ]);

  const effectiveTrackedProjectIds = useMemo(() => {
    if (isProjectRailWindow) {
      return [];
    }

    if (!shouldManageProjectWindows) {
      return trackedProjectIds;
    }

    return railVisible
      ? buildTrackedProjectIds(projectId, openProjectIds, projectsById, true)
      : trackedProjectIds;
  }, [
    isProjectRailWindow,
    openProjectIds,
    projectId,
    projectsById,
    railVisible,
    shouldManageProjectWindows,
    trackedProjectIds,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    tauriListen<boolean>('project-rail-visibility', (visible) => {
      setRailVisible(visible);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [setRailVisible]);

  useEffect(() => {
    if (!shouldManageProjectWindows) {
      return;
    }

    if (isProjectRailWindow) {
      let unlisten: (() => void) | undefined;

      tauriListen<ProjectWindowTrackingState>(
        PROJECT_WINDOW_TRACKING_EVENT,
        (payload) => {
          replaceProjectTrackingState(payload);
        }
      ).then((dispose) => {
        unlisten = dispose;
        void tauriEmit(PROJECT_WINDOW_TRACKING_REQUEST_EVENT).catch((error) => {
          console.error(
            'Failed to request project tracking state from main window:',
            error
          );
        });
      });

      return () => {
        unlisten?.();
      };
    }

    void tauriEmit(PROJECT_WINDOW_TRACKING_EVENT, {
      openProjectIds,
      lastRouteByProject,
      projectSnapshots,
      projectAlerts,
    } satisfies ProjectWindowTrackingState).catch((error) => {
      console.error('Failed to sync project tracking state to project rail:', error);
    });
  }, [
    isProjectRailWindow,
    lastRouteByProject,
    openProjectIds,
    projectAlerts,
    projectSnapshots,
    railVisible,
    replaceProjectTrackingState,
    shouldManageProjectWindows,
  ]);

  useEffect(() => {
    if (!shouldManageProjectWindows || isProjectRailWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;

    tauriListen(PROJECT_WINDOW_TRACKING_REQUEST_EVENT, () => {
      void tauriEmit(PROJECT_WINDOW_TRACKING_EVENT, {
        openProjectIds,
        lastRouteByProject,
        projectSnapshots,
        projectAlerts,
      } satisfies ProjectWindowTrackingState).catch((error) => {
        console.error(
          'Failed to answer project tracking state request:',
          error
        );
      });
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [
    isProjectRailWindow,
    lastRouteByProject,
    openProjectIds,
    projectAlerts,
    projectSnapshots,
    shouldManageProjectWindows,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    tauriListen<ProjectRailNavigationTarget>(
      'project-rail-activated',
      (payload) => {
        ensureProjectOpen(payload.projectId);
        navigate(payload.route);
      }
    ).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [ensureProjectOpen, navigate]);

  return (
    <>
      {effectiveTrackedProjectIds.map((trackedProjectId) => (
        <ProjectActivityTracker
          key={trackedProjectId}
          projectId={trackedProjectId}
          isActive={trackedProjectId === projectId}
          enableNotifications={!isProjectRailWindow}
        />
      ))}
    </>
  );
}

export function ProjectRailProjectDialogBridge() {
  const navigate = useNavigate();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    tauriListen<ProjectRailProjectDialogRequest>(
      'project-rail-project-dialog-requested',
      async (payload) => {
        const result = await ProjectFormDialog.show({
          autoOpenFolderPicker: payload.mode === 'open',
        });
        if (result?.status !== 'saved' || !result.project) {
          return;
        }

        ensureProjectOpen(result.project.id);
        navigate(paths.projectSessions(result.project.id));
      }
    ).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [ensureProjectOpen, navigate]);

  return null;
}
