import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { IDockviewPanelProps } from 'dockview-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import {
  type KanbanProjectSessionRecord,
  useKanbanProjectSessions,
} from '@/hooks/useKanbanProjectSessions';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { sessionsApi } from '@/lib/api';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';
import { paths } from '@/lib/paths';
import { WorkspaceSessionList } from './WorkspaceSessionList';

function WorkspaceSessionListPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'common', 'tasks']);
  const navigate = useNavigateWithSearch();
  const { projectId } = useProject();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { visibleRightSession, replaceRightSession } =
    useKanbanSessionContext();
  const queryClient = useQueryClient();
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const activeSessionId =
    routeSessionId ?? visibleRightSession?.sessionId ?? null;
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status !== 'archived'),
    [sessions]
  );

  const openSession = useCallback(
    (session: (typeof activeSessions)[number]) => {
      replaceRightSession(session.placement);
      setActiveWorktree(session.workspace.id, session.taskId);
      if (projectId) {
        navigate(
          paths.projectSession(projectId, session.workspace.id, session.id)
        );
      }
    },
    [navigate, projectId, replaceRightSession, setActiveWorktree]
  );

  const refreshWorkspaceSessions = useCallback(
    (workspaceId: string) =>
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', workspaceId],
      }),
    [queryClient]
  );

  const pinSession = useCallback(
    async (session: KanbanProjectSessionRecord, pinned: boolean) => {
      try {
        await sessionsApi.setPinned(session.id, pinned);
        await refreshWorkspaceSessions(session.workspace.id);
      } catch (error) {
        toast.error(
          getSessionUiErrorMessage(error, t('workspaceSessionList.pinFailed'))
        );
      }
    },
    [refreshWorkspaceSessions, t]
  );

  const archiveSession = useCallback(
    async (session: KanbanProjectSessionRecord) => {
      try {
        await sessionsApi.updateStatus(session.id, 'archived');
        await refreshWorkspaceSessions(session.workspace.id);
      } catch (error) {
        toast.error(
          getSessionUiErrorMessage(
            error,
            t('workspaceSessionList.archiveFailed')
          )
        );
      }
    },
    [refreshWorkspaceSessions, t]
  );

  const renameSession = useCallback(
    async (session: KanbanProjectSessionRecord, name: string | null) => {
      try {
        await sessionsApi.rename(session.id, name);
        await refreshWorkspaceSessions(session.workspace.id);
      } catch (error) {
        toast.error(
          getSessionUiErrorMessage(
            error,
            t('workspaceSessionList.renameFailed')
          )
        );
      }
    },
    [refreshWorkspaceSessions, t]
  );

  const deleteSession = useCallback(
    async (session: KanbanProjectSessionRecord) => {
      const result = await ConfirmDialog.show({
        title: t('tasks:sessionHub.deleteSessionTitle'),
        message: t('tasks:sessionHub.deleteSessionConfirm', {
          name: session.fullName,
        }),
        confirmText: t('common:delete'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;

      try {
        await sessionsApi.delete(session.id);
        await refreshWorkspaceSessions(session.workspace.id);
      } catch (error) {
        toast.error(
          getSessionUiErrorMessage(
            error,
            t('workspaceSessionList.deleteFailed')
          )
        );
      }
    },
    [refreshWorkspaceSessions, t]
  );

  return (
    <TooltipProvider delayDuration={120}>
      <section
        className="flex h-full min-h-0 flex-col bg-background"
        aria-label={t('workspaceSessionList.title')}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          <WorkspaceSessionList
            sessions={activeSessions}
            isLoading={isLoading}
            activeSessionId={activeSessionId}
            activeWorkspaceId={activeWorktreeId}
            onSessionClick={openSession}
            onPinSession={(session, pinned) => {
              void pinSession(session, pinned);
            }}
            onArchiveSession={(session) => {
              void archiveSession(session);
            }}
            onRenameSession={(session, name) => {
              void renameSession(session, name);
            }}
            onDeleteSession={(session) => {
              void deleteSession(session);
            }}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}

export default WorkspaceSessionListPanel;
