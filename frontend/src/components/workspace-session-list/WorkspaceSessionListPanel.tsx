import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
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
import { conversationApi } from '@/features/conversation/conversationApi';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';
import { paths } from '@/lib/paths';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { removeSessionsFromWorkspaceCaches } from '@/lib/sessionQueryCache';
import { useKanbanSessionMutations } from '@/components/kanban/session-hub/useKanbanSessionMutations';
import {
  getBulkDeleteSessionSummary,
  toggleStringValue,
} from '@/components/kanban/session-hub/utils';
import { WorkspaceSessionList } from './WorkspaceSessionList';
import { WorkspaceSessionListToolbar } from './WorkspaceSessionListToolbar';
import {
  sessionMatchesQuery,
  toggleSessionListSort,
  type SessionListSortSpec,
} from './workspaceSessionListModel';

function resolveRestoredSessionName(
  session: KanbanProjectSessionRecord,
  activeSessions: KanbanProjectSessionRecord[]
) {
  const baseName = session.fullName.trim() || session.name?.trim() || 'session';
  const activeNames = new Set(
    activeSessions
      .map((candidate) => candidate.fullName.trim())
      .filter((name) => name.length > 0)
  );

  if (!activeNames.has(baseName)) {
    return null;
  }

  let suffix = 1;
  let candidateName = `${baseName}_${suffix}`;
  while (activeNames.has(candidateName)) {
    suffix += 1;
    candidateName = `${baseName}_${suffix}`;
  }

  return candidateName;
}

function WorkspaceSessionListPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'common', 'tasks']);
  const navigate = useNavigateWithSearch();
  const { projectId } = useProject();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { visibleRightSession, replaceRightSession, pruneSessions } =
    useKanbanSessionContext();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const activeSessionId =
    routeSessionId ?? visibleRightSession?.sessionId ?? null;
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status !== 'archived'),
    [sessions]
  );
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.status === 'archived'),
    [sessions]
  );
  const sessionsById = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session])),
    [sessions]
  );

  const [isArchiveView, setIsArchiveView] = useState(false);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [isDeletingSessions, setIsDeletingSessions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortSpecs, setSortSpecs] = useState<SessionListSortSpec[]>([]);
  const [searchHitIds, setSearchHitIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    setSelectedSessionIds((current) => {
      const available = new Set(sessions.map((session) => session.id));
      const next = current.filter((sessionId) => available.has(sessionId));
      return next.length === current.length ? current : next;
    });
  }, [sessions]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchHitIds(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      conversationApi
        .search(trimmed, null, 80)
        .then((hits) => {
          if (!cancelled) {
            setSearchHitIds(new Set(hits.map((hit) => hit.conversation_id)));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchHitIds(new Set());
          }
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const { renameSessionMutation } = useKanbanSessionMutations({
    projectId,
    primaryRepoId: null,
    workspaceBranchOptions: [],
    getWorkspaceRepoInputs: () => [],
    placeCreatedSession: () => undefined,
    addPendingCreatedSession: () => undefined,
    clearCreateSessionName: () => undefined,
    closeCreatePopover: () => undefined,
  });

  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds]
  );
  const sourceSessions = isArchiveView ? archivedSessions : activeSessions;
  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) {
      return sourceSessions;
    }
    return sourceSessions.filter(
      (session) =>
        sessionMatchesQuery(session, query) ||
        Boolean(searchHitIds?.has(session.id))
    );
  }, [searchHitIds, searchQuery, sourceSessions]);

  const openSession = useCallback(
    (session: KanbanProjectSessionRecord) => {
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

  const restoreSession = useCallback(
    async (session: KanbanProjectSessionRecord) => {
      try {
        const restoredName = resolveRestoredSessionName(
          session,
          activeSessions
        );
        if (restoredName) {
          await renameSessionMutation.mutateAsync({
            sessionId: session.id,
            name: restoredName,
            workspaceId: session.workspace.id,
          });
        }
        await sessionsApi.updateStatus(session.id, 'done');
        await refreshWorkspaceSessions(session.workspace.id);
      } catch (error) {
        toast.error(
          getSessionUiErrorMessage(
            error,
            t('workspaceSessionList.restoreFailed')
          )
        );
      }
    },
    [activeSessions, refreshWorkspaceSessions, renameSessionMutation, t]
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

  const handleCancelDeleteMode = () => {
    setIsDeleteMode(false);
    setSelectedSessionIds([]);
  };

  const handleToggleDeleteMode = () => {
    if (isDeleteMode) {
      handleCancelDeleteMode();
      return;
    }
    setIsDeleteMode(true);
    setSelectedSessionIds([]);
  };

  const handleArchiveViewChange = (value: boolean) => {
    setIsArchiveView(value);
    if (value) {
      handleCancelDeleteMode();
    }
  };

  const handleSessionClick = (session: KanbanProjectSessionRecord) => {
    if (isDeleteMode) {
      setSelectedSessionIds((current) =>
        toggleStringValue(current, session.id)
      );
      return;
    }
    openSession(session);
  };

  const handleDeleteSelectedSessions = async () => {
    if (selectedSessionIds.length === 0 || isDeletingSessions) {
      return;
    }

    const result = await ConfirmDialog.show({
      title: t('tasks:sessionHub.deleteSessionTitle'),
      message: t('tasks:sessionHub.deleteSelectedConfirm', {
        count: selectedSessionIds.length,
      }),
      confirmText: t('common:delete'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;

    setIsDeletingSessions(true);
    const targetIds = [...selectedSessionIds];
    const deleteResults = await Promise.allSettled(
      targetIds.map(async (sessionId) => {
        await sessionsApi.delete(sessionId);
        return sessionId;
      })
    );
    const deleteSummary = getBulkDeleteSessionSummary({
      targetIds,
      sessionsById,
      sessions,
      deleteResults,
    });

    removeSessionsFromWorkspaceCaches(queryClient, deleteSummary.succeededIds);
    await Promise.all(
      deleteSummary.affectedWorkspaceIds.map((workspaceId) =>
        refreshWorkspaceSessions(workspaceId)
      )
    );

    if (deleteSummary.succeededIds.length > 0) {
      pruneSessions(deleteSummary.remainingSessionIds);
    }

    if (deleteSummary.failedResults.length > 0) {
      toast.error(t('workspaceSessionList.deleteFailed'));
      setSelectedSessionIds(deleteSummary.failedSessionIds);
    } else {
      handleCancelDeleteMode();
    }

    setIsDeletingSessions(false);
  };

  const handleCreateSession = () => {
    requestCreateSessionInExecutionArea(setSearchParams, searchParams);
  };

  const emptyMessage = searchQuery.trim()
    ? t('workspaceSessionList.searchEmpty')
    : isArchiveView
      ? t('workspaceSessionList.archiveEmpty')
      : undefined;

  return (
    <TooltipProvider delayDuration={120}>
      <section
        className="flex h-full min-h-0 flex-col bg-background"
        aria-label={t('workspaceSessionList.title')}
      >
        <WorkspaceSessionListToolbar
          isArchiveView={isArchiveView}
          isDeleteMode={isDeleteMode}
          selectedCount={selectedSessionIdSet.size}
          isDeletingSessions={isDeletingSessions}
          searchQuery={searchQuery}
          sortSpecs={sortSpecs}
          onArchiveViewChange={handleArchiveViewChange}
          onToggleDeleteMode={handleToggleDeleteMode}
          onCancelDeleteMode={handleCancelDeleteMode}
          onDeleteSelected={() => {
            void handleDeleteSelectedSessions();
          }}
          onCreateSession={handleCreateSession}
          onSearchQueryChange={setSearchQuery}
          onToggleSortKey={(key) => {
            setSortSpecs((current) => toggleSessionListSort(current, key));
          }}
          onClearSort={() => setSortSpecs([])}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {!isLoading && visibleSessions.length === 0 && emptyMessage ? (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            <WorkspaceSessionList
              sessions={visibleSessions}
              sortSpecs={sortSpecs}
              isLoading={isLoading}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorktreeId}
              showPinnedSection={!isArchiveView}
              isDeleteMode={isDeleteMode}
              selectedSessionIds={selectedSessionIdSet}
              onSessionClick={handleSessionClick}
              onToggleSessionSelection={(sessionId) => {
                setSelectedSessionIds((current) =>
                  toggleStringValue(current, sessionId)
                );
              }}
              onPinSession={
                isArchiveView
                  ? undefined
                  : (session, pinned) => {
                      void pinSession(session, pinned);
                    }
              }
              onArchiveSession={
                isArchiveView
                  ? undefined
                  : (session) => {
                      void archiveSession(session);
                    }
              }
              onRestoreSession={
                isArchiveView
                  ? (session) => {
                      void restoreSession(session);
                    }
                  : undefined
              }
              onRenameSession={(session, name) => {
                void renameSession(session, name);
              }}
              onDeleteSession={(session) => {
                void deleteSession(session);
              }}
            />
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

export default WorkspaceSessionListPanel;
