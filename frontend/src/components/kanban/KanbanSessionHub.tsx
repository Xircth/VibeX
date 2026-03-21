import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ScratchType, type ExecutorProfileId } from 'shared/types';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import {
  useTaskAttempt,
  useTaskAttemptWithSession,
} from '@/hooks/useTaskAttempt';
import { useProjectRepos } from '@/hooks';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { scratchApi, sessionsApi } from '@/lib/api';
import { paths } from '@/lib/paths';
import { getFirstAvailableProfile } from '@/utils/executor';
import { SessionHubMonitor } from './session-hub/SessionHubMonitor';
import { SessionHubSidebar } from './session-hub/SessionHubSidebar';
import {
  DEFAULT_SESSION_LIST_WIDTH,
  MAX_SESSION_LIST_WIDTH,
  MIN_SESSION_LIST_WIDTH,
  SESSION_LIST_WIDTH_STORAGE_KEY,
  UNASSIGNED_EXECUTOR,
  getExecutorDisplayName,
  getExecutorFilterValue,
  mapSessionErrorMessage,
  sortSessions,
  toggleStringValue,
  type SortField,
} from './session-hub/utils';

type SessionStatusKey = 'todo' | 'inprogress' | 'inreview' | 'done';
const MAINLINE_BRANCH_NAMES = new Set(['main', 'master']);

function isMainlineBranch(branch: string) {
  const normalized = branch.trim().toLowerCase();
  return (
    MAINLINE_BRANCH_NAMES.has(normalized) ||
    normalized.endsWith('/main') ||
    normalized.endsWith('/master')
  );
}

function matchesBranch(branch: string, expectedBranch: string) {
  const normalized = branch.trim().toLowerCase();
  return (
    normalized === expectedBranch || normalized.endsWith(`/${expectedBranch}`)
  );
}

export function KanbanSessionHub() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);
  const { activeWorktreeId } = useWorktree();
  const { profiles, config } = useUserSystem();
  const {
    rightSession,
    monitorSessions,
    lastActiveWorkspaceId,
    canUseRightPanelForSessions,
    openSessionFromList,
    placeCreatedSession,
    promoteMonitorSession,
    pruneSessions,
  } = useKanbanSessionContext();
  const { data: activeAttempt } = useTaskAttemptWithSession(
    activeWorktreeId ?? undefined
  );
  const { data: lastActiveWorkspace } = useTaskAttempt(
    lastActiveWorkspaceId ?? undefined
  );
  const { sessions, sessionsById, workspaces, isLoading } =
    useKanbanProjectSessions(projectId);

  const createWorkspaceOptions = useMemo(() => {
    if (
      !lastActiveWorkspace ||
      workspaces.some((workspace) => workspace.id === lastActiveWorkspace.id)
    ) {
      return workspaces;
    }

    return [lastActiveWorkspace, ...workspaces];
  }, [lastActiveWorkspace, workspaces]);

  const preferredMainBranch = useMemo(
    () =>
      repos
        ?.map((repo) => repo.default_target_branch?.trim().toLowerCase() ?? '')
        .find((branch) => branch.length > 0) ?? null,
    [repos]
  );

  const mainlineWorkspaceId = useMemo(
    () =>
      createWorkspaceOptions.find((workspace) =>
        preferredMainBranch
          ? matchesBranch(workspace.branch, preferredMainBranch)
          : isMainlineBranch(workspace.branch)
      )?.id ?? null,
    [createWorkspaceOptions, preferredMainBranch]
  );

  const defaultExecutorProfile = useMemo<ExecutorProfileId | null>(
    () => config?.executor_profile ?? getFirstAvailableProfile(profiles),
    [config?.executor_profile, profiles]
  );

  const defaultWorkspaceId = useMemo(() => {
    if (
      lastActiveWorkspaceId &&
      createWorkspaceOptions.some(
        (workspace) => workspace.id === lastActiveWorkspaceId
      )
    ) {
      return lastActiveWorkspaceId;
    }

    if (mainlineWorkspaceId) {
      return mainlineWorkspaceId;
    }

    return createWorkspaceOptions[0]?.id ?? '';
  }, [createWorkspaceOptions, lastActiveWorkspaceId, mainlineWorkspaceId]);

  const [createWorkspaceId, setCreateWorkspaceId] =
    useState(defaultWorkspaceId);
  const [createSessionName, setCreateSessionName] = useState('');
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const [isCreatePopoverOpen, setIsCreatePopoverOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [workspaceFilterIds, setWorkspaceFilterIds] = useState<string[]>([]);
  const [executorFilterValues, setExecutorFilterValues] = useState<string[]>(
    []
  );
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(
    null
  );
  const [deleteSuccessMessage, setDeleteSuccessMessage] = useState<
    string | null
  >(null);
  const [isDeletingSessions, setIsDeletingSessions] = useState(false);
  const [expandedSections, setExpandedSections] = useState<
    Record<SessionStatusKey, boolean>
  >({
    todo: true,
    inprogress: true,
    inreview: true,
    done: true,
  });
  const [sessionListWidth, setSessionListWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_SESSION_LIST_WIDTH;
    }

    const stored = Number.parseInt(
      window.localStorage.getItem(SESSION_LIST_WIDTH_STORAGE_KEY) ?? '',
      10
    );

    if (Number.isNaN(stored)) {
      return DEFAULT_SESSION_LIST_WIDTH;
    }

    return Math.min(
      MAX_SESSION_LIST_WIDTH,
      Math.max(MIN_SESSION_LIST_WIDTH, stored)
    );
  });
  const sessionListResizeStartRef = useRef<{
    x: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (
      !createWorkspaceId ||
      !createWorkspaceOptions.some(
        (workspace) => workspace.id === createWorkspaceId
      )
    ) {
      setCreateWorkspaceId(defaultWorkspaceId);
    }
  }, [createWorkspaceId, createWorkspaceOptions, defaultWorkspaceId]);

  useEffect(() => {
    setSelectedExecutorProfile((current) => current ?? defaultExecutorProfile);
  }, [defaultExecutorProfile]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      SESSION_LIST_WIDTH_STORAGE_KEY,
      String(sessionListWidth)
    );
  }, [sessionListWidth]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    pruneSessions(new Set(sessions.map((session) => session.id)));
  }, [isLoading, pruneSessions, sessions]);

  useEffect(() => {
    const availableSessionIds = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((current) => {
      const next = current.filter((sessionId) =>
        availableSessionIds.has(sessionId)
      );
      return next.length === current.length ? current : next;
    });
  }, [sessions]);

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!createWorkspaceId) {
        throw new Error('Workspace is required');
      }

      const session = await sessionsApi.create({
        workspace_id: createWorkspaceId,
        executor: selectedExecutorProfile?.executor ?? undefined,
        name: createSessionName.trim() || null,
      });

      if (selectedExecutorProfile?.executor) {
        await scratchApi.update(ScratchType.DRAFT_FOLLOW_UP, session.id, {
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: {
              message: '',
              executor_profile_id: selectedExecutorProfile,
            },
          },
        });
      }

      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace_id],
      });
      placeCreatedSession({
        sessionId: session.id,
        workspaceId: session.workspace_id,
      });
      setCreateSessionName('');
      setIsCreatePopoverOpen(false);
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async ({
      sessionId,
      name,
      workspaceId,
    }: {
      sessionId: string;
      name: string | null;
      workspaceId: string;
    }) => {
      await sessionsApi.rename(sessionId, name);
      return { sessionId, workspaceId };
    },
    onSuccess: ({ sessionId, workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['session', sessionId],
      });
    },
  });

  const executorFilterOptions = useMemo(() => {
    const values = Array.from(
      new Set(
        sessions.map((session) => getExecutorFilterValue(session.executor))
      )
    );

    return values
      .map((value) => ({
        value,
        label: getExecutorDisplayName(
          value === UNASSIGNED_EXECUTOR ? null : value
        ),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }, [sessions]);

  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) => {
        if (
          workspaceFilterIds.length > 0 &&
          !workspaceFilterIds.includes(session.workspace.id)
        ) {
          return false;
        }

        if (
          executorFilterValues.length > 0 &&
          !executorFilterValues.includes(
            getExecutorFilterValue(session.executor)
          )
        ) {
          return false;
        }

        return true;
      }),
    [executorFilterValues, sessions, workspaceFilterIds]
  );

  const flatSessions = useMemo(
    () => sortSessions(filteredSessions, sortField),
    [filteredSessions, sortField]
  );

  const groupedSessions = useMemo(() => {
    const groups: Record<SessionStatusKey, KanbanProjectSessionRecord[]> = {
      todo: [],
      inprogress: [],
      inreview: [],
      done: [],
    };

    sessions.forEach((session) => {
      groups[session.status as SessionStatusKey].push(session);
    });

    return groups;
  }, [sessions]);

  const monitorRecords = useMemo(
    () =>
      monitorSessions
        .filter(
          (placement) => placement.sessionId !== activeAttempt?.session?.id
        )
        .map((placement) => sessionsById[placement.sessionId])
        .filter((session): session is KanbanProjectSessionRecord =>
          Boolean(session)
        ),
    [activeAttempt?.session?.id, monitorSessions, sessionsById]
  );

  const monitorPlacements = useMemo(
    () => monitorRecords.map((session) => session.placement),
    [monitorRecords]
  );

  const currentExecutionPlacement = useMemo(() => {
    if (activeWorktreeId && activeAttempt?.session?.id) {
      return {
        sessionId: activeAttempt.session.id,
        workspaceId: activeWorktreeId,
      };
    }

    return rightSession;
  }, [activeAttempt?.session?.id, activeWorktreeId, rightSession]);

  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds]
  );

  const canCreateSession =
    !!createWorkspaceId &&
    !!selectedExecutorProfile?.executor &&
    !createSessionMutation.isPending;

  const displayedCount =
    workspaceFilterIds.length > 0 ||
    executorFilterValues.length > 0 ||
    sortField !== null
      ? flatSessions.length
      : sessions.length;

  const handleCreatePopoverOpenChange = (open: boolean) => {
    setIsCreatePopoverOpen(open);

    if (open) {
      setCreateWorkspaceId(defaultWorkspaceId);
      setSelectedExecutorProfile(defaultExecutorProfile);
      setCreateSessionName('');
      setDeleteErrorMessage(null);
    } else {
      createSessionMutation.reset();
    }
  };

  const handleResetViewState = () => {
    setSortField(null);
    setWorkspaceFilterIds([]);
    setExecutorFilterValues([]);
  };

  const handleCancelDeleteMode = () => {
    setIsDeleteMode(false);
    setSelectedSessionIds([]);
    setDeleteErrorMessage(null);
  };

  const handleToggleDeleteMode = () => {
    if (isDeleteMode) {
      handleCancelDeleteMode();
      return;
    }

    setIsDeleteMode(true);
    setSelectedSessionIds([]);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);
  };

  const handleToggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds((current) => toggleStringValue(current, sessionId));
  };

  const handleSessionClick = (session: KanbanProjectSessionRecord) => {
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    if (isDeleteMode) {
      handleToggleSessionSelection(session.id);
      return;
    }

    openSessionFromList(session.placement);
  };

  const handleSessionStatusChange = async (
    session: KanbanProjectSessionRecord,
    nextStatus: KanbanProjectSessionRecord['status']
  ) => {
    if (session.status === nextStatus) {
      return;
    }

    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    try {
      await sessionsApi.updateStatus(session.id, nextStatus);
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace.id],
      });
    } catch (error) {
      setDeleteErrorMessage(
        mapSessionErrorMessage(error, '更新会话状态失败，请稍后重试。')
      );
    }
  };

  const handleDeleteSelectedSessions = async () => {
    if (selectedSessionIds.length === 0 || isDeletingSessions) {
      return;
    }

    const result = await ConfirmDialog.show({
      title: '删除会话',
      message: `确定删除已选中的 ${selectedSessionIds.length} 个会话吗？正在执行中的会话不会被删除。`,
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingSessions(true);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    const targetIds = [...selectedSessionIds];
    const targetSessions = targetIds
      .map((sessionId) => sessionsById[sessionId])
      .filter((session): session is KanbanProjectSessionRecord =>
        Boolean(session)
      );

    const deleteResults = await Promise.allSettled(
      targetIds.map(async (sessionId) => {
        await sessionsApi.delete(sessionId);
        return sessionId;
      })
    );

    const succeededIds = deleteResults
      .filter(
        (result): result is PromiseFulfilledResult<string> =>
          result.status === 'fulfilled'
      )
      .map((result) => result.value);

    const failedResults = deleteResults
      .map((result, index) => ({ result, sessionId: targetIds[index] }))
      .filter(
        (
          item
        ): item is {
          result: PromiseRejectedResult;
          sessionId: string;
        } => item.result.status === 'rejected'
      );

    const affectedWorkspaceIds = Array.from(
      new Set(targetSessions.map((session) => session.workspace.id))
    );

    await Promise.all(
      affectedWorkspaceIds.map((workspaceId) =>
        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        })
      )
    );

    succeededIds.forEach((sessionId) => {
      queryClient.removeQueries({
        queryKey: ['session', sessionId],
      });
    });

    if (succeededIds.length > 0) {
      const remainingSessionIds = new Set(
        sessions
          .map((session) => session.id)
          .filter((sessionId) => !succeededIds.includes(sessionId))
      );
      pruneSessions(remainingSessionIds);
      setDeleteSuccessMessage(`已删除 ${succeededIds.length} 个会话。`);
    }

    if (failedResults.length > 0) {
      setDeleteErrorMessage(
        failedResults
          .map(({ result }) =>
            mapSessionErrorMessage(result.reason, '删除失败，请稍后重试。')
          )
          .join('；')
      );
      setSelectedSessionIds(failedResults.map(({ sessionId }) => sessionId));
    } else {
      handleCancelDeleteMode();
    }

    setIsDeletingSessions(false);
  };

  const handleOpenInExecutionArea = (session: KanbanProjectSessionRecord) => {
    if (canUseRightPanelForSessions) {
      promoteMonitorSession(session.id);
      return;
    }

    if (!projectId || !session.taskId) {
      return;
    }

    navigate(paths.attempt(projectId, session.taskId, session.workspace.id));
  };

  const handleSessionListResizeMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault();

    sessionListResizeStartRef.current = {
      x: event.clientX,
      width: sessionListWidth,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const start = sessionListResizeStartRef.current;
      if (!start) {
        return;
      }

      const nextWidth = start.width + (moveEvent.clientX - start.x);
      setSessionListWidth(
        Math.min(
          MAX_SESSION_LIST_WIDTH,
          Math.max(MIN_SESSION_LIST_WIDTH, nextWidth)
        )
      );
    };

    const handleMouseUp = () => {
      sessionListResizeStartRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex h-full min-h-0 bg-background">
        <SessionHubSidebar
          width={sessionListWidth}
          isLoading={isLoading}
          sessions={sessions}
          groupedSessions={groupedSessions}
          flatSessions={flatSessions}
          workspaces={workspaces}
          createWorkspaceOptions={createWorkspaceOptions}
          profiles={profiles}
          createWorkspaceId={createWorkspaceId}
          createSessionName={createSessionName}
          selectedExecutorProfile={selectedExecutorProfile}
          isCreatePopoverOpen={isCreatePopoverOpen}
          sortField={sortField}
          workspaceFilterIds={workspaceFilterIds}
          executorFilterValues={executorFilterValues}
          executorFilterOptions={executorFilterOptions}
          expandedSections={expandedSections}
          isDeleteMode={isDeleteMode}
          selectedSessionIdSet={selectedSessionIdSet}
          deleteErrorMessage={deleteErrorMessage}
          deleteSuccessMessage={deleteSuccessMessage}
          isDeletingSessions={isDeletingSessions}
          canCreateSession={canCreateSession}
          isCreatePending={createSessionMutation.isPending}
          createError={createSessionMutation.error}
          displayedCount={displayedCount}
          monitorPlacements={monitorPlacements}
          currentExecutionPlacement={currentExecutionPlacement}
          onResizeMouseDown={handleSessionListResizeMouseDown}
          onCreatePopoverOpenChange={handleCreatePopoverOpenChange}
          onCreateSession={() => createSessionMutation.mutate()}
          onCreateWorkspaceIdChange={setCreateWorkspaceId}
          onCreateSessionNameChange={setCreateSessionName}
          onSelectedExecutorProfileChange={(value) =>
            setSelectedExecutorProfile(value)
          }
          onSortFieldChange={setSortField}
          onWorkspaceFilterIdsChange={setWorkspaceFilterIds}
          onExecutorFilterValuesChange={setExecutorFilterValues}
          onResetViewState={handleResetViewState}
          onToggleDeleteMode={handleToggleDeleteMode}
          onCancelDeleteMode={handleCancelDeleteMode}
          onDeleteSelectedSessions={handleDeleteSelectedSessions}
          onSessionClick={handleSessionClick}
          onToggleSessionSelection={handleToggleSessionSelection}
          onRenameSession={async (session, name) => {
            await renameSessionMutation.mutateAsync({
              sessionId: session.id,
              name,
              workspaceId: session.workspace.id,
            });
          }}
          onSessionStatusChange={(session, nextStatus) => {
            void handleSessionStatusChange(session, nextStatus);
          }}
          onExpandedChange={(status, expanded) => {
            setExpandedSections((current) => ({
              ...current,
              [status as SessionStatusKey]: expanded,
            }));
          }}
        />

        <SessionHubMonitor
          monitorRecords={monitorRecords}
          canUseRightPanelForSessions={canUseRightPanelForSessions}
          onOpenInExecutionArea={handleOpenInExecutionArea}
        />
      </div>
    </TooltipProvider>
  );
}
