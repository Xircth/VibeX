import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import { useUserSystem } from '@/components/ConfigProvider';
import { attemptsApi, configApi } from '@/lib/api';
import { paths } from '@/lib/paths';
import { ProjectRail } from '@/components/layout/ProjectRail';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

function getSessionStatusLabel(session: KanbanProjectSessionRecord) {
  if (session.isRunning) {
    return '执行中';
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

function findLatestSessionForTask(
  sessions: KanbanProjectSessionRecord[],
  taskId: string
) {
  return (
    sessions.find((session) => session.taskId === taskId) ?? sessions[0] ?? null
  );
}

function ProjectActivityTracker({
  projectId,
  isActive,
}: {
  projectId: string;
  isActive: boolean;
}) {
  const navigate = useNavigate();
  const { config } = useUserSystem();
  const { projectsById } = useProjects();
  const { tasks, isLoading } = useProjectTasks(projectId);
  const { sessions } = useKanbanProjectSessions(projectId);
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
  const previousTaskStateRef = useRef<Record<string, { running: boolean }>>({});
  const hasInitializedRef = useRef(false);
  const previousSnapshotSignatureRef = useRef<string>('');

  const snapshot = useMemo(() => {
    const recentSessions = sessions.slice(0, 5).map((session) => {
      const isFailedSession = session.task?.last_attempt_failed ?? false;
      const visualState = session.isRunning
        ? 'loading'
        : isFailedSession
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
      hasRunning: tasks.some((task) => task.has_in_progress_attempt),
      hasError: tasks.some((task) => task.last_attempt_failed),
      hasSessions: sessions.length > 0,
      recentSessions,
    };
  }, [isLoading, sessions, tasks]);

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
        // Ignore mark-seen failures for passive status sync.
      });
    }
  }, [isActive, markProjectAlertRead, projectAlert, projectId]);

  useEffect(() => {
    const currentTaskStates = Object.fromEntries(
      tasks.map((task) => [
        task.id,
        {
          running: task.has_in_progress_attempt,
        },
      ])
    );

    if (!hasInitializedRef.current) {
      previousTaskStateRef.current = currentTaskStates;
      hasInitializedRef.current = true;
      return;
    }

    tasks.forEach((task) => {
      const previousTaskState = previousTaskStateRef.current[task.id];
      if (!previousTaskState?.running || task.has_in_progress_attempt) {
        return;
      }

      const latestSession = findLatestSessionForTask(sessions, task.id);
      if (!latestSession) {
        return;
      }

      const kind = task.last_attempt_failed ? 'error' : 'success';
      const projectName = projectsById[projectId]?.name ?? '项目';
      const title =
        kind === 'error'
          ? `${projectName} 中的会话执行失败`
          : `${projectName} 中有会话已完成`;
      const description = `${task.title} · ${latestSession.fullName}`;

      setProjectAlert({
        projectId,
        workspaceId: latestSession.workspace.id,
        sessionId: latestSession.id,
        taskId: task.id,
        kind,
        unread: !isActive,
        createdAt: latestSession.updatedAt,
        title,
        description,
      });

      if (config?.notifications.push_enabled) {
        if (config.notifications.sound_enabled) {
          void configApi
            .playNotificationSound(config.notifications.sound_file)
            .catch((error) => {
              console.error('Failed to play toast notification sound:', error);
            });
        }
        toast.custom(
          (toastId) => (
            <div className="relative overflow-hidden rounded-2xl">
              <button
                type="button"
                className="flex w-full flex-col gap-2 px-4 py-3 pr-10 text-left"
                onClick={() => {
                  setRailVisible(true);
                  ensureProjectOpen(projectId);
                  requestProjectFocus(projectId, {
                    workspaceId: latestSession.workspace.id,
                    sessionId: latestSession.id,
                    requestedAt: Date.now(),
                  });
                  setProjectActiveTab(projectId, 'kanban');
                  navigate(paths.projectTasks(projectId));
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
                  点击查看对应项目与会话
                </span>
              </button>
              <button
                type="button"
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="关闭通知"
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
      }
    });

    previousTaskStateRef.current = currentTaskStates;
  }, [
    config?.notifications.push_enabled,
    config?.notifications.sound_enabled,
    config?.notifications.sound_file,
    ensureProjectOpen,
    isActive,
    navigate,
    projectId,
    projectsById,
    requestProjectFocus,
    sessions,
    setProjectActiveTab,
    setProjectAlert,
    setRailVisible,
    tasks,
  ]);

  return null;
}

export function ProjectWindowManager() {
  const location = useLocation();
  const { projectId } = useProject();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const rememberProjectRoute = useWindowProjectsStore(
    (state) => state.rememberProjectRoute
  );
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );

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

  const trackedProjectIds = useMemo(
    () =>
      Array.from(
        new Set([...(projectId ? [projectId] : []), ...openProjectIds])
      ),
    [openProjectIds, projectId]
  );

  const showProjectRail =
    !location.pathname.startsWith('/settings') &&
    !location.pathname.endsWith('/full');

  return (
    <>
      {showProjectRail ? <ProjectRail /> : null}
      {trackedProjectIds.map((trackedProjectId) => (
        <ProjectActivityTracker
          key={trackedProjectId}
          projectId={trackedProjectId}
          isActive={trackedProjectId === projectId}
        />
      ))}
    </>
  );
}
