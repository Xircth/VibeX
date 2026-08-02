import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import { SoundFile } from 'shared/types';
import { useTranslation } from 'react-i18next';
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
import { backendListen } from '@/lib/backendTransport';
import { desktopApi } from '@/lib/api';
import { dateTimestamp } from '@/utils/date';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useStopToastSuppression } from '@/stores/useTaskDetailsUiStore';
import { deliverSessionCompletionNotification } from './sessionCompletionNotification';

function getSessionStatusLabel(
  session: KanbanProjectSessionRecord,
  t: TFunction<['panels', 'common']>
) {
  if (session.isRunning) {
    return t('windowManager.statusRunning');
  }

  switch (session.status) {
    case 'done':
      return t('windowManager.statusDone');
    case 'inreview':
      return t('windowManager.statusInReview');
    case 'inprogress':
      return t('windowManager.statusInProgress');
    case 'todo':
      return t('windowManager.statusTodo');
    default:
      return t('windowManager.statusIdle');
  }
}

type ProjectSessionTarget = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
};

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
  const { t } = useTranslation(['panels', 'common']);
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
        statusLabel: getSessionStatusLabel(session, t),
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
  }, [isLoading, sessions, t]);

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

    backendListen<ProjectSessionTarget>(
      'desktop-toast-activated',
      (payload) => {
        if (payload.projectId !== projectId) {
          return;
        }

        openProjectSession(payload);
      }
    ).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [openProjectSession, projectId]);

  const resolveSummaryDisplayName = useCallback(
    (summary: SessionSummary) => {
      const manualName = summary.name?.trim();
      if (manualName) {
        return manualName;
      }

      const firstPrompt =
        summary.first_prompt?.replace(/\s+/g, ' ').trim() ?? '';
      if (firstPrompt.length > 0) {
        return Array.from(firstPrompt).slice(0, 8).join('');
      }

      return (
        summary.display_name?.trim() || t('windowManager.sessionFallbackName')
      );
    },
    [t]
  );

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
          const projectName =
            projectsById[projectId]?.name ??
            t('windowManager.projectFallbackName');
          const title =
            kind === 'error'
              ? t('windowManager.sessionFailedTitle', { project: projectName })
              : t('windowManager.sessionCompletedTitle', {
                  project: projectName,
                });
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

          void deliverSessionCompletionNotification({
            kind,
            windowFocused,
            soundEnabled: config?.notifications.sound_enabled ?? false,
            soundFile:
              config?.notifications.sound_file ?? SoundFile.ABSTRACT_SOUND1,
            pushEnabled: config?.notifications.push_enabled ?? false,
            playSound: configApi.playNotificationSound,
            showPush: () =>
              showDesktopToast({
                projectId,
                workspaceId: workspace.id,
                sessionId: latestSummary.id,
                title,
                description,
                kind,
                durationMs: 15000,
              }),
          }).catch((error) => {
            console.error('Failed to deliver session completion notification:', error);
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
    t,
    workspacesWithStatus,
  ]);

  return null;
}

export function ProjectWindowManager() {
  const location = useLocation();
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
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const pruneProjectState = useWindowProjectsStore(
    (state) => state.pruneProjectState
  );
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

  const trackedProjectIds = useMemo(() => {
    if (!shouldManageProjectWindows) {
      return [];
    }

    return buildTrackedProjectIds(
      projectId,
      openProjectIds,
      projectsById,
      false
    );
  }, [openProjectIds, projectId, projectsById, shouldManageProjectWindows]);

  const effectiveTrackedProjectIds = useMemo(() => {
    if (!shouldManageProjectWindows) {
      return trackedProjectIds;
    }

    return railVisible
      ? buildTrackedProjectIds(projectId, openProjectIds, projectsById, true)
      : trackedProjectIds;
  }, [
    openProjectIds,
    projectId,
    projectsById,
    railVisible,
    shouldManageProjectWindows,
    trackedProjectIds,
  ]);

  return (
    <>
      {effectiveTrackedProjectIds.map((trackedProjectId) => (
        <ProjectActivityTracker
          key={trackedProjectId}
          projectId={trackedProjectId}
          isActive={trackedProjectId === projectId}
        />
      ))}
    </>
  );
}
