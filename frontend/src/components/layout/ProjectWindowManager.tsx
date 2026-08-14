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

type ConversationFinishedPayload = ProjectSessionTarget & {
  turnId: string;
  kind: 'success' | 'error';
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

function resolveSummaryDisplayName(summary: SessionSummary, t: TFunction) {
  const manualName = summary.name?.trim();
  if (manualName) return manualName;

  const firstPrompt = summary.first_prompt?.replace(/\s+/g, ' ').trim() ?? '';
  if (firstPrompt.length > 0) {
    return Array.from(firstPrompt).slice(0, 8).join('');
  }

  return summary.display_name?.trim() || t('windowManager.sessionFallbackName');
}

function ProjectNotificationBridge() {
  const { t } = useTranslation(['panels', 'common']);
  const navigate = useNavigate();
  const { projectId: activeProjectId } = useProject();
  const { config } = useUserSystem();
  const { projectsById } = useProjects();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const setProjectAlert = useWindowProjectsStore(
    (state) => state.setProjectAlert
  );
  const requestProjectFocus = useWindowProjectsStore(
    (state) => state.requestProjectFocus
  );
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const setProjectActiveTab = useLayoutStore(
    (state) => state.setProjectActiveTab
  );
  const { consumeStopToastSuppression } = useStopToastSuppression();
  const latestNotificationStateRef = useRef({
    activeProjectId,
    config,
    projectsById,
    consumeStopToastSuppression,
    t,
  });
  latestNotificationStateRef.current = {
    activeProjectId,
    config,
    projectsById,
    consumeStopToastSuppression,
    t,
  };

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

  const isApplicationCurrentlyFocused = useCallback(async () => {
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
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    backendListen<ProjectSessionTarget>(
      'desktop-toast-activated',
      openProjectSession
    ).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openProjectSession]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    backendListen<ConversationFinishedPayload>(
      'desktop-conversation-finished',
      (payload) => {
        void sessionsApi
          .getSummariesByWorkspace(payload.workspaceId)
          .then(async (summaries) => {
            if (cancelled) return;
            const completedSummary = summaries.find(
              (summary) => summary.id === payload.sessionId
            );
            if (!completedSummary) {
              console.error(
                `Completed session ${payload.sessionId} was not found in workspace ${payload.workspaceId}`
              );
              return;
            }

            const latest = latestNotificationStateRef.current;
            const projectName =
              latest.projectsById[payload.projectId]?.name ??
              latest.t('windowManager.projectFallbackName');
            const title = latest.t('windowManager.sessionCompletedTitle', {
              project: projectName,
            });
            const sessionName = resolveSummaryDisplayName(
              completedSummary,
              latest.t
            );
            const workspaceName =
              completedSummary.workspace_name ?? payload.workspaceId;
            const description = `${sessionName} · ${workspaceName}`;
            const windowFocused = await isApplicationCurrentlyFocused();
            if (cancelled) return;

            setProjectAlert({
              projectId: payload.projectId,
              workspaceId: payload.workspaceId,
              sessionId: completedSummary.id,
              taskId: completedSummary.task_id,
              kind: payload.kind,
              unread:
                payload.projectId !== latest.activeProjectId || !windowFocused,
              createdAt: completedSummary.updated_at,
              title,
              description,
            });

            if (latest.consumeStopToastSuppression(payload.workspaceId)) return;

            void deliverSessionCompletionNotification({
              kind: payload.kind,
              windowFocused,
              soundEnabled: latest.config?.notifications.sound_enabled ?? false,
              soundFile:
                latest.config?.notifications.sound_file ??
                SoundFile.ABSTRACT_SOUND1,
              pushEnabled: latest.config?.notifications.push_enabled ?? false,
              playSound: configApi.playNotificationSound,
              showPush: () =>
                showDesktopToast({
                  projectId: payload.projectId,
                  workspaceId: payload.workspaceId,
                  sessionId: completedSummary.id,
                  title,
                  description,
                  kind: payload.kind,
                  durationMs: 15000,
                }),
            }).catch((error) => {
              console.error(
                'Failed to deliver session completion notification:',
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
      }
    ).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isApplicationCurrentlyFocused, setProjectAlert]);

  return null;
}

function ProjectActivityTracker({
  projectId,
  isActive,
}: {
  projectId: string;
  isActive: boolean;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const setProjectSnapshot = useWindowProjectsStore(
    (state) => state.setProjectSnapshot
  );
  const markProjectAlertRead = useWindowProjectsStore(
    (state) => state.markProjectAlertRead
  );
  const projectAlert = useWindowProjectsStore(
    (state) => state.projectAlerts[projectId]
  );
  const previousSnapshotSignatureRef = useRef<string>('');

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
  const isAppManagementRoute =
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/plugins');
  const shouldManageProjectWindows = !isAppManagementRoute;

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
      <ProjectNotificationBridge />
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
