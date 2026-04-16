import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { X } from 'lucide-react';
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
import { tauriListen } from '@/lib/tauriApi';
import { desktopApi } from '@/lib/api';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

function getSessionStatusLabel(session: KanbanProjectSessionRecord) {
  if (session.isRunning) {
    return 'Running';
  }

  switch (session.status) {
    case 'done':
      return 'Completed';
    case 'inreview':
      return 'In Review';
    case 'inprogress':
      return 'In Progress';
    case 'todo':
      return 'Todo';
    default:
      return 'Idle';
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

  const showInlineToast = useCallback(
    ({
      kind,
      title,
      description,
      workspaceId,
      sessionId,
    }: {
      kind: 'success' | 'error';
      title: string;
      description: string;
      workspaceId: string;
      sessionId: string;
    }) => {
      toast.custom(
        (toastId) => (
          <div className="relative overflow-hidden rounded-2xl">
            <button
              type="button"
              className="flex w-full flex-col gap-2 px-4 py-3 pr-10 text-left"
              onClick={() => {
                openProjectSession({
                  projectId,
                  workspaceId,
                  sessionId,
                });
                toast.dismiss(toastId);
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    kind === 'error'
                      ? 'h-2.5 w-2.5 rounded-full bg-red-500'
                      : 'h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse'
                  }
                />
                <span className="text-sm font-semibold">{title}</span>
              </div>
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {description}
              </span>
              <span className="text-[11px] font-medium text-primary">
                Click to open the related session
              </span>
            </button>
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close notification"
              onClick={(event) => {
                event.stopPropagation();
                toast.dismiss(toastId);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
        {
          duration: 15000,
        }
      );
    },
    [openProjectSession, projectId]
  );

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
        .then((summaries) => {
          if (cancelled || summaries.length === 0) {
            return;
          }

          const latestSummary = [...summaries].sort(
            (left, right) =>
              new Date(right.updated_at).getTime() -
              new Date(left.updated_at).getTime()
          )[0];

          const kind = workspace.is_errored ? 'error' : 'success';
          const projectName = projectsById[projectId]?.name ?? 'Project';
          const title =
            kind === 'error'
              ? `${projectName}: session failed`
              : `${projectName}: session completed`;
          const sessionName = resolveSummaryDisplayName(latestSummary);
          const workspaceName =
            latestSummary.workspace_name ?? workspace.name ?? workspace.branch;
          const description = `${sessionName} · ${workspaceName}`;
          const windowFocused =
            typeof document !== 'undefined' &&
            document.visibilityState === 'visible' &&
            document.hasFocus();
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

          if (!config?.notifications.push_enabled) {
            return;
          }

          if (config.notifications.sound_enabled) {
            void configApi
              .playNotificationSound(config.notifications.sound_file)
              .catch((error) => {
                console.error('Failed to play desktop toast sound:', error);
              });
          }

          if (!windowFocused) {
            void showDesktopToast({
              projectId,
              workspaceId: workspace.id,
              sessionId: latestSummary.id,
              title,
              description,
              kind,
              durationMs: 15000,
            }).catch(() => {
              showInlineToast({
                kind,
                title,
                description,
                workspaceId: workspace.id,
                sessionId: latestSummary.id,
              });
            });
            return;
          }

          showInlineToast({
            kind,
            title,
            description,
            workspaceId: workspace.id,
            sessionId: latestSummary.id,
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
    enableNotifications,
    isActive,
    projectId,
    projectsById,
    resolveSummaryDisplayName,
    setProjectAlert,
    showInlineToast,
    workspacesWithStatus,
  ]);

  return null;
}

export function ProjectWindowManager() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { projects } = useProjects();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const rememberProjectRoute = useWindowProjectsStore(
    (state) => state.rememberProjectRoute
  );
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const isProjectRailWindow = location.pathname === '/project-rail';

  useEffect(() => {
    if (!projectId) {
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
  ]);

  useEffect(() => {
    if (isProjectRailWindow) {
      return;
    }

    void desktopApi
      .setProjectRailWindowVisible(railVisible, projects.length)
      .catch((error) => {
        console.error('Failed to sync project rail window visibility:', error);
      });
  }, [isProjectRailWindow, projects.length, railVisible]);

  const trackedProjectIds = useMemo(() => {
    if (isProjectRailWindow) {
      return [];
    }

    return Array.from(
      new Set([...(projectId ? [projectId] : []), ...openProjectIds])
    );
  }, [isProjectRailWindow, openProjectIds, projectId]);

  const effectiveTrackedProjectIds = useMemo(() => {
    if (isProjectRailWindow) {
      return projects.map((project) => project.id);
    }

    return trackedProjectIds;
  }, [isProjectRailWindow, projects, trackedProjectIds]);

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
