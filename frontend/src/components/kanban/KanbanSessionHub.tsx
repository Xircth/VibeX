import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type ExecutorProfileId } from 'shared/types';
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
import { useProjectRepos, useRepoBranchSelection } from '@/hooks';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { sessionsApi, type SessionStatus } from '@/lib/api';
import type { KanbanZone } from '@/lib/layoutArrangement';
import { resolveCurrentExecutionPlacement } from '@/lib/kanbanSessionLayout';
import { paths } from '@/lib/paths';
import { removeSessionsFromWorkspaceCaches } from '@/lib/sessionQueryCache';
import {
  buildWorkspaceBranchOptions,
  findCurrentProjectBranchOption,
  findWorkspaceBranchOption,
  findWorkspaceBranchOptionByWorkspaceId,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';
import { getFirstAvailableProfile } from '@/utils/executor';
import { type SessionCreationMode } from '@/components/sessions/SessionCreationForm';
import { SessionHubMonitor } from './session-hub/SessionHubMonitor';
import { SessionHubSidebar } from './session-hub/SessionHubSidebar';
import { useKanbanSessionMutations } from './session-hub/useKanbanSessionMutations';
import {
  DEFAULT_SESSION_LIST_WIDTH,
  ARCHIVED_SESSION_STATUS,
  MAX_SESSION_LIST_WIDTH,
  MIN_SESSION_LIST_WIDTH,
  SESSION_LIST_WIDTH_STORAGE_KEY,
  getBulkDeleteSessionSummary,
  getCanCreateKanbanSession,
  getDisplayedSessionCount,
  getExecutorFilterOptions,
  filterKanbanSessions,
  groupKanbanSessionsByStatus,
  mapSessionErrorMessage,
  sortSessions,
  toggleStringValue,
  type ActiveSessionStatus,
  type SortField,
} from './session-hub/utils';

type SessionStatusKey = ActiveSessionStatus;
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

interface KanbanSessionHubProps {
  /** Left-to-right zone order for the hub row (list / monitor / session). */
  zoneOrder?: readonly KanbanZone[];
  /** Rendered between list and monitor when the session zone sits center. */
  sessionSlot?: ReactNode;
}

export function KanbanSessionHub({
  zoneOrder = ['list', 'monitor', 'session'],
  sessionSlot = null,
}: KanbanSessionHubProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);
  const projectRepos = repos ?? [];
  const { activeWorktreeId } = useWorktree();
  const { profiles, config } = useUserSystem();
  const {
    goToSessionHub,
    rightSession,
    monitorSessions,
    lastActiveWorkspaceId,
    canUseRightPanelForSessions,
    openSessionFromList,
    placeCreatedSession,
    promoteMonitorSession,
    cancelMonitorSession,
    pruneSessions,
  } = useKanbanSessionContext();
  const { data: activeAttempt } = useTaskAttemptWithSession(
    activeWorktreeId ?? undefined
  );
  const { data: lastActiveWorkspace } = useTaskAttempt(
    lastActiveWorkspaceId ?? undefined
  );
  const { sessions, workspaces, isLoading } =
    useKanbanProjectSessions(projectId);
  const primaryRepo = repos?.[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });

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
  const workspaceBranchOptions = useMemo(
    () =>
      buildWorkspaceBranchOptions({
        workspaces: createWorkspaceOptions,
        repoBranches: primaryRepoBranches,
      }),
    [createWorkspaceOptions, primaryRepoBranches]
  );
  const mainlineWorkspaceValue = useMemo(
    () =>
      workspaceBranchOptions.find((option) =>
        preferredMainBranch
          ? matchesBranch(option.branch, preferredMainBranch)
          : isMainlineBranch(option.branch)
      )?.value ?? null,
    [preferredMainBranch, workspaceBranchOptions]
  );

  const defaultExecutorProfile = useMemo<ExecutorProfileId | null>(
    () => config?.executor_profile ?? getFirstAvailableProfile(profiles),
    [config?.executor_profile, profiles]
  );

  const defaultWorkspaceValue = useMemo(() => {
    const currentProjectBranchOption = findCurrentProjectBranchOption(
      workspaceBranchOptions
    );
    if (currentProjectBranchOption) {
      return currentProjectBranchOption.value;
    }

    const lastActiveOption = findWorkspaceBranchOptionByWorkspaceId(
      workspaceBranchOptions,
      lastActiveWorkspaceId
    );
    if (lastActiveOption) {
      return lastActiveOption.value;
    }

    if (mainlineWorkspaceValue) {
      return mainlineWorkspaceValue;
    }

    return workspaceBranchOptions[0]?.value ?? '';
  }, [lastActiveWorkspaceId, mainlineWorkspaceValue, workspaceBranchOptions]);

  const [createWorkspaceValue, setCreateWorkspaceValue] = useState(
    defaultWorkspaceValue
  );
  const [createMode, setCreateMode] =
    useState<SessionCreationMode>('existing_workspace');
  const [createSessionName, setCreateSessionName] = useState('');
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const createWorkspaceValueRef = useRef(createWorkspaceValue);
  const createSessionNameRef = useRef(createSessionName);
  const selectedExecutorProfileRef = useRef(selectedExecutorProfile);
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
  const [isArchiveView, setIsArchiveView] = useState(false);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [pendingCreatedSessionIds, setPendingCreatedSessionIds] = useState<
    string[]
  >([]);
  const [optimisticStatusBySessionId, setOptimisticStatusBySessionId] =
    useState<Record<string, SessionStatus>>({});
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
  const {
    configs: repoBranchConfigs,
    isLoading: isLoadingRepoBranches,
    setRepoBranch,
    getWorkspaceRepoInputs,
    reset: resetRepoBranchSelection,
  } = useRepoBranchSelection({
    repos: projectRepos,
    enabled: isCreatePopoverOpen,
  });

  const updateCreateWorkspaceValue = useCallback((value: string) => {
    createWorkspaceValueRef.current = value;
    setCreateWorkspaceValue(value);
  }, []);

  const updateCreateSessionName = useCallback((value: string) => {
    createSessionNameRef.current = value;
    setCreateSessionName(value);
  }, []);

  const updateSelectedExecutorProfile = useCallback(
    (value: ExecutorProfileId | null) => {
      selectedExecutorProfileRef.current = value;
      setSelectedExecutorProfile(value);
    },
    []
  );

  useEffect(() => {
    if (
      !createWorkspaceValue ||
      !workspaceBranchOptions.some(
        (option) => option.value === createWorkspaceValue
      )
    ) {
      updateCreateWorkspaceValue(defaultWorkspaceValue);
    }
  }, [
    createWorkspaceValue,
    defaultWorkspaceValue,
    updateCreateWorkspaceValue,
    workspaceBranchOptions,
  ]);

  useEffect(() => {
    updateSelectedExecutorProfile(
      selectedExecutorProfileRef.current ?? defaultExecutorProfile
    );
  }, [defaultExecutorProfile, updateSelectedExecutorProfile]);

  useEffect(() => {
    if (workspaceBranchOptions.length === 0) {
      setCreateMode('new_workspace');
    }
  }, [workspaceBranchOptions.length]);

  useEffect(() => {
    if (searchParams.get('createSession') !== '1') {
      return;
    }

    goToSessionHub();
    updateCreateWorkspaceValue(defaultWorkspaceValue);
    updateSelectedExecutorProfile(defaultExecutorProfile);
    updateCreateSessionName('');
    setCreateMode(
      workspaceBranchOptions.length > 0 ? 'existing_workspace' : 'new_workspace'
    );
    resetRepoBranchSelection();
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);
    setIsCreatePopoverOpen(true);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('createSession');
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    defaultExecutorProfile,
    defaultWorkspaceValue,
    workspaceBranchOptions.length,
    goToSessionHub,
    resetRepoBranchSelection,
    searchParams,
    setSearchParams,
    updateCreateSessionName,
    updateCreateWorkspaceValue,
    updateSelectedExecutorProfile,
  ]);

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
    if (!openingSessionId) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setOpeningSessionId((current) =>
        current === openingSessionId ? null : current
      );
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [openingSessionId]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const availableSessionIds = new Set([
      ...sessions.map((session) => session.id),
      ...pendingCreatedSessionIds,
    ]);
    pruneSessions(availableSessionIds);
  }, [isLoading, pendingCreatedSessionIds, pruneSessions, sessions]);

  useEffect(() => {
    if (pendingCreatedSessionIds.length === 0 || isLoading) {
      return;
    }

    const availableSessionIds = new Set(sessions.map((session) => session.id));
    setPendingCreatedSessionIds((current) => {
      const next = current.filter(
        (sessionId) => !availableSessionIds.has(sessionId)
      );
      return next.length === current.length ? current : next;
    });
  }, [isLoading, pendingCreatedSessionIds.length, sessions]);

  useEffect(() => {
    setOptimisticStatusBySessionId((current) => {
      let changed = false;
      const next = { ...current };

      Object.entries(current).forEach(([sessionId, optimisticStatus]) => {
        const latestSession = sessions.find(
          (session) => session.id === sessionId
        );
        if (!latestSession || latestSession.status === optimisticStatus) {
          delete next[sessionId];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    const availableSessionIds = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((current) => {
      const next = current.filter((sessionId) =>
        availableSessionIds.has(sessionId)
      );
      return next.length === current.length ? current : next;
    });
  }, [sessions]);

  const { createSessionMutation, renameSessionMutation } =
    useKanbanSessionMutations({
      projectId,
      primaryRepoId: primaryRepo?.id,
      workspaceBranchOptions,
      getWorkspaceRepoInputs,
      placeCreatedSession,
      addPendingCreatedSession: (sessionId) => {
        setPendingCreatedSessionIds((current) =>
          current.includes(sessionId) ? current : [...current, sessionId]
        );
      },
      clearCreateSessionName: () => updateCreateSessionName(''),
      closeCreatePopover: () => setIsCreatePopoverOpen(false),
    });

  const sessionsWithOptimisticStatus = useMemo(
    () =>
      sessions.map((session) => {
        const optimisticStatus = optimisticStatusBySessionId[session.id];
        if (!optimisticStatus || optimisticStatus === session.status) {
          return session;
        }

        return {
          ...session,
          status: optimisticStatus,
          isCompleted: optimisticStatus === 'done',
        };
      }),
    [optimisticStatusBySessionId, sessions]
  );

  const activeSessionsWithOptimisticStatus = useMemo(
    () =>
      sessionsWithOptimisticStatus.filter(
        (session) => session.status !== ARCHIVED_SESSION_STATUS
      ),
    [sessionsWithOptimisticStatus]
  );

  const archivedSessionsWithOptimisticStatus = useMemo(
    () =>
      sessionsWithOptimisticStatus.filter(
        (session) => session.status === ARCHIVED_SESSION_STATUS
      ),
    [sessionsWithOptimisticStatus]
  );

  const sessionsById = useMemo(
    () =>
      sessionsWithOptimisticStatus.reduce<
        Record<string, KanbanProjectSessionRecord>
      >((accumulator, session) => {
        accumulator[session.id] = session;
        return accumulator;
      }, {}),
    [sessionsWithOptimisticStatus]
  );

  const executorFilterOptions = useMemo(
    () => getExecutorFilterOptions(activeSessionsWithOptimisticStatus),
    [activeSessionsWithOptimisticStatus]
  );

  const filteredSessions = useMemo(
    () =>
      filterKanbanSessions({
        sessions: activeSessionsWithOptimisticStatus,
        workspaceFilterIds,
        executorFilterValues,
      }),
    [
      executorFilterValues,
      activeSessionsWithOptimisticStatus,
      workspaceFilterIds,
    ]
  );

  const flatSessions = useMemo(
    () => sortSessions(filteredSessions, sortField),
    [filteredSessions, sortField]
  );

  const groupedSessions = useMemo(() => {
    return groupKanbanSessionsByStatus(activeSessionsWithOptimisticStatus);
  }, [activeSessionsWithOptimisticStatus]);

  const activeWorkspacePlacement = useMemo(() => {
    if (activeWorktreeId && activeAttempt?.session?.id) {
      return {
        sessionId: activeAttempt.session.id,
        workspaceId: activeWorktreeId,
      };
    }

    return null;
  }, [activeAttempt?.session?.id, activeWorktreeId]);

  const currentExecutionPlacement = useMemo(
    () =>
      resolveCurrentExecutionPlacement(rightSession, activeWorkspacePlacement, {
        canUseRightPanel: canUseRightPanelForSessions,
      }),
    [activeWorkspacePlacement, canUseRightPanelForSessions, rightSession]
  );

  const monitorRecords = useMemo(
    () =>
      monitorSessions
        .filter(
          (placement) =>
            placement.sessionId !== currentExecutionPlacement?.sessionId
        )
        .map((placement) => sessionsById[placement.sessionId])
        .filter((session): session is KanbanProjectSessionRecord =>
          Boolean(session)
        ),
    [currentExecutionPlacement?.sessionId, monitorSessions, sessionsById]
  );

  const monitorPlacements = useMemo(
    () => monitorRecords.map((session) => session.placement),
    [monitorRecords]
  );

  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds]
  );
  const selectedWorkspaceOption = useMemo<WorkspaceBranchOption | null>(
    () =>
      findWorkspaceBranchOption(workspaceBranchOptions, createWorkspaceValue),
    [createWorkspaceValue, workspaceBranchOptions]
  );

  const canCreateSession = getCanCreateKanbanSession({
    executorProfile: selectedExecutorProfile,
    isPending: createSessionMutation.isPending,
    mode: createMode,
    selectedWorkspaceOption,
    projectRepoCount: projectRepos.length,
    repoBranchConfigs,
  });

  const displayedCount = getDisplayedSessionCount({
    workspaceFilterIds,
    executorFilterValues,
    sortField,
    filteredCount: flatSessions.length,
    activeCount: activeSessionsWithOptimisticStatus.length,
  });

  const handleCreatePopoverOpenChange = (open: boolean) => {
    setIsCreatePopoverOpen(open);

    if (open) {
      updateCreateWorkspaceValue(defaultWorkspaceValue);
      updateSelectedExecutorProfile(defaultExecutorProfile);
      updateCreateSessionName('');
      setCreateMode(
        workspaceBranchOptions.length > 0
          ? 'existing_workspace'
          : 'new_workspace'
      );
      resetRepoBranchSelection();
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

  const handleArchiveViewChange = (value: boolean) => {
    setIsArchiveView(value);
    setDeleteSuccessMessage(null);
    setDeleteErrorMessage(null);

    if (value) {
      setIsDeleteMode(false);
      setSelectedSessionIds([]);
    }
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

    const isAlreadyOpen =
      currentExecutionPlacement?.sessionId === session.id ||
      monitorPlacements.some((placement) => placement.sessionId === session.id);

    if (!isAlreadyOpen) {
      setOpeningSessionId(session.id);
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
      setOptimisticStatusBySessionId((current) => ({
        ...current,
        [session.id]: nextStatus,
      }));

      await sessionsApi.updateStatus(session.id, nextStatus);
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace.id],
      });
    } catch (error) {
      setOptimisticStatusBySessionId((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      setDeleteErrorMessage(
        mapSessionErrorMessage(error, t('sessionHub.updateStatusFailed'))
      );
    }
  };

  const handleRestoreArchivedSession = async (
    session: KanbanProjectSessionRecord
  ) => {
    if (session.status !== ARCHIVED_SESSION_STATUS) {
      return;
    }

    const restoredName = resolveRestoredSessionName(
      session,
      activeSessionsWithOptimisticStatus
    );

    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    try {
      setOptimisticStatusBySessionId((current) => ({
        ...current,
        [session.id]: 'done',
      }));

      if (restoredName) {
        await renameSessionMutation.mutateAsync({
          sessionId: session.id,
          name: restoredName,
          workspaceId: session.workspace.id,
        });
      }

      await sessionsApi.updateStatus(session.id, 'done');
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace.id],
      });
    } catch (error) {
      setOptimisticStatusBySessionId((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      setDeleteErrorMessage(
        mapSessionErrorMessage(error, t('sessionHub.restoreArchivedFailed'))
      );
    }
  };

  const handleDeleteSession = async (session: KanbanProjectSessionRecord) => {
    if (isDeletingSessions) {
      return;
    }

    const result = await ConfirmDialog.show({
      title: t('sessionHub.deleteSessionTitle'),
      message: t('sessionHub.deleteSessionConfirm', {
        name: session.fullName,
      }),
      confirmText: t('common:delete'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingSessions(true);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    try {
      await sessionsApi.delete(session.id);
      removeSessionsFromWorkspaceCaches(queryClient, [session.id]);
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace.id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['taskAttemptWithSession', session.workspace.id],
      });

      const remainingSessionIds = new Set(
        sessions
          .map((candidate) => candidate.id)
          .filter((sessionId) => sessionId !== session.id)
      );
      pruneSessions(remainingSessionIds);
      setSelectedSessionIds((current) =>
        current.filter((sessionId) => sessionId !== session.id)
      );
      setDeleteSuccessMessage(t('sessionHub.deleteSuccess', { count: 1 }));
    } catch (error) {
      setDeleteErrorMessage(
        mapSessionErrorMessage(error, t('sessionHub.deleteFailed'))
      );
    } finally {
      setIsDeletingSessions(false);
    }
  };

  const handleDeleteSelectedSessions = async () => {
    if (selectedSessionIds.length === 0 || isDeletingSessions) {
      return;
    }

    const result = await ConfirmDialog.show({
      title: t('sessionHub.deleteSessionTitle'),
      message: t('sessionHub.deleteSelectedConfirm', {
        count: selectedSessionIds.length,
      }),
      confirmText: t('common:delete'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingSessions(true);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

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
    const { succeededIds } = deleteSummary;

    removeSessionsFromWorkspaceCaches(queryClient, deleteSummary.succeededIds);

    await Promise.all(
      deleteSummary.affectedWorkspaceIds.map((workspaceId) =>
        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        })
      )
    );

    await Promise.all(
      deleteSummary.affectedWorkspaceIds.map((workspaceId) =>
        queryClient.invalidateQueries({
          queryKey: ['taskAttemptWithSession', workspaceId],
        })
      )
    );

    if (deleteSummary.succeededIds.length > 0) {
      pruneSessions(deleteSummary.remainingSessionIds);
      setDeleteSuccessMessage(
        t('sessionHub.deleteSuccess', { count: succeededIds.length })
      );
    }

    if (deleteSummary.failedResults.length > 0) {
      setDeleteErrorMessage(
        deleteSummary.failedResults
          .map(({ result }) =>
            mapSessionErrorMessage(result.reason, t('sessionHub.deleteFailed'))
          )
          .join(t('sessionHub.errorSeparator'))
      );
      setSelectedSessionIds(deleteSummary.failedSessionIds);
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

    if (!projectId) {
      return;
    }

    navigate(paths.projectSession(projectId, session.workspace.id, session.id));
  };

  const handleCancelMonitor = (session: KanbanProjectSessionRecord) => {
    cancelMonitorSession(session.id);
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

  const sidebarElement = (
    <SessionHubSidebar
      width={sessionListWidth}
      isLoading={isLoading}
      sessions={activeSessionsWithOptimisticStatus}
      archivedSessions={archivedSessionsWithOptimisticStatus}
      groupedSessions={groupedSessions}
      flatSessions={flatSessions}
      workspaces={workspaces}
      workspaceBranchOptions={workspaceBranchOptions}
      profiles={profiles}
      createMode={createMode}
      createWorkspaceValue={createWorkspaceValue}
      createSessionName={createSessionName}
      selectedExecutorProfile={selectedExecutorProfile}
      repoBranchConfigs={repoBranchConfigs}
      isLoadingRepoBranches={isLoadingRepoBranches}
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
      openingSessionId={openingSessionId}
      isArchiveView={isArchiveView}
      onResizeMouseDown={handleSessionListResizeMouseDown}
      onArchiveViewChange={handleArchiveViewChange}
      onCreatePopoverOpenChange={handleCreatePopoverOpenChange}
      onCreateSession={() =>
        createSessionMutation.mutate({
          workspaceValue: createWorkspaceValueRef.current,
          sessionName: createSessionNameRef.current,
          executorProfile: selectedExecutorProfileRef.current,
          mode: createMode,
        })
      }
      onCreateModeChange={setCreateMode}
      onCreateWorkspaceValueChange={updateCreateWorkspaceValue}
      onCreateSessionNameChange={updateCreateSessionName}
      onSelectedExecutorProfileChange={updateSelectedExecutorProfile}
      onRepoBranchChange={setRepoBranch}
      onSortFieldChange={setSortField}
      onWorkspaceFilterIdsChange={setWorkspaceFilterIds}
      onExecutorFilterValuesChange={setExecutorFilterValues}
      onResetViewState={handleResetViewState}
      onToggleDeleteMode={handleToggleDeleteMode}
      onCancelDeleteMode={handleCancelDeleteMode}
      onDeleteSelectedSessions={handleDeleteSelectedSessions}
      onSessionClick={handleSessionClick}
      onToggleSessionSelection={handleToggleSessionSelection}
      onDeleteSession={handleDeleteSession}
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
      onRestoreArchivedSession={(session) => {
        void handleRestoreArchivedSession(session);
      }}
      onExpandedChange={(status, expanded) => {
        setExpandedSections((current) => ({
          ...current,
          [status as SessionStatusKey]: expanded,
        }));
      }}
    />
  );

  const monitorElement = (
    <SessionHubMonitor
      monitorRecords={monitorRecords}
      canUseRightPanelForSessions={canUseRightPanelForSessions}
      onOpenInExecutionArea={handleOpenInExecutionArea}
      onCancelMonitor={handleCancelMonitor}
    />
  );

  return (
    <TooltipProvider delayDuration={120}>
      <div className="session-hub-shell flex h-full min-h-0">
        {zoneOrder.map((zone) => (
          <Fragment key={zone}>
            {zone === 'list'
              ? sidebarElement
              : zone === 'monitor'
                ? monitorElement
                : sessionSlot}
          </Fragment>
        ))}
      </div>
    </TooltipProvider>
  );
}
