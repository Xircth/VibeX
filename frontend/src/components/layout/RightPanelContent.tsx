import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { RightPanelNewSessionPrompt } from '@/components/layout/RightPanelNewSessionPrompt';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useUserSystem } from '@/components/ConfigProvider';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { RightPanelSessionCreationProvider } from '@/contexts/RightPanelSessionCreationContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import {
  useProjectRepos,
  useProjectWorktrees,
  useRepoBranches,
  useRepoBranchSelection,
} from '@/hooks';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useProject } from '@/contexts/ProjectContext';
import { scratchApi, sessionsApi } from '@/lib/api';
import {
  buildWorkspaceBranchOptions,
  findCurrentProjectBranchOption,
  findWorkspaceBranchOption,
  findWorkspaceBranchOptionByWorkspaceId,
  resolveWorkspaceBranchSelection,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';
import { getFirstAvailableProfile } from '@/utils/executor';
import {
  SessionCreationForm,
  type SessionControlsPreset,
  type SessionCreationMode,
} from '@/components/sessions/SessionCreationForm';
import { initializeSessionControls } from '@/features/conversation/initializeSessionControls';
import {
  ScratchType,
  type ExecutorProfileId,
  type Workspace,
} from 'shared/types';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import { paths } from '@/lib/paths';
import { confirmWorktreeCreation } from '@/lib/confirmWorktreeCreation';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';

const MAINLINE_BRANCH_NAMES = new Set(['main', 'master']);
const CREATE_SESSION_ERROR_FALLBACK =
  'Failed to create session. Please try again.';

function matchesBranch(branch: string, expectedBranch: string) {
  const normalized = branch.trim().toLowerCase();
  return (
    normalized === expectedBranch || normalized.endsWith(`/${expectedBranch}`)
  );
}

function isMainlineBranch(branch: string) {
  const normalized = branch.trim().toLowerCase();
  return (
    MAINLINE_BRANCH_NAMES.has(normalized) ||
    normalized.endsWith('/main') ||
    normalized.endsWith('/master')
  );
}

function CreateSessionOverlay({
  createMode,
  setCreateMode,
  workspaceBranchOptions,
  createWorkspaceValue,
  setCreateWorkspaceValue,
  createSessionName,
  setCreateSessionName,
  profiles,
  selectedExecutorProfile,
  setSelectedExecutorProfile,
  repoBranchConfigs,
  setRepoBranch,
  isLoadingRepoBranches,
  canCreateSession,
  isCreatePending,
  createError,
  onSubmitCreate,
  onClose,
  onSessionControlsPresetChange,
}: {
  createMode: SessionCreationMode;
  setCreateMode: (value: SessionCreationMode) => void;
  workspaceBranchOptions: WorkspaceBranchOption[];
  createWorkspaceValue: string;
  setCreateWorkspaceValue: (value: string) => void;
  createSessionName: string;
  setCreateSessionName: (value: string) => void;
  profiles: ReturnType<typeof useUserSystem>['profiles'];
  selectedExecutorProfile: ExecutorProfileId | null;
  setSelectedExecutorProfile: (value: ExecutorProfileId | null) => void;
  repoBranchConfigs: ReturnType<typeof useRepoBranchSelection>['configs'];
  setRepoBranch: ReturnType<typeof useRepoBranchSelection>['setRepoBranch'];
  isLoadingRepoBranches: boolean;
  canCreateSession: boolean;
  isCreatePending: boolean;
  createError: unknown;
  onSubmitCreate: () => void;
  onClose: () => void;
  onSessionControlsPresetChange?: (
    preset: SessionControlsPreset | null
  ) => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-6 backdrop-blur-md">
      <div className="relative w-full max-w-[360px] rounded-xl border border-border/70 bg-background/95 p-4 shadow-xl">
        <button
          className="absolute right-2 top-2 z-10 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </button>
        <div className="mb-4 space-y-1">
          <div className="text-sm font-semibold text-foreground">
            {t('rightPanelContent.newSession')}
          </div>
        </div>

        <SessionCreationForm
          mode={createMode}
          onModeChange={setCreateMode}
          workspaceBranchOptions={workspaceBranchOptions}
          selectedWorkspaceValue={createWorkspaceValue}
          onSelectedWorkspaceValueChange={setCreateWorkspaceValue}
          sessionName={createSessionName}
          onSessionNameChange={setCreateSessionName}
          profiles={profiles}
          selectedExecutorProfile={selectedExecutorProfile}
          onSelectedExecutorProfileChange={setSelectedExecutorProfile}
          repoBranchConfigs={repoBranchConfigs}
          onRepoBranchChange={setRepoBranch}
          isLoadingBranches={isLoadingRepoBranches}
          onSessionControlsPresetChange={onSessionControlsPresetChange}
          canSubmit={canCreateSession}
          isSubmitting={isCreatePending}
          errorMessage={
            createError
              ? getSessionUiErrorMessage(
                  createError,
                  CREATE_SESSION_ERROR_FALLBACK
                )
              : null
          }
          onSubmit={onSubmitCreate}
          onCancel={onClose}
          dropdownSide="top"
        />
      </div>
    </div>
  );
}

export function RightPanelContent() {
  const { t } = useTranslation(['panels', 'common', 'settings']);
  const navigate = useNavigateWithSearch();
  const {
    projectId: routeProjectId,
    workspaceId,
    sessionId,
  } = useParams<{
    projectId?: string;
    workspaceId?: string;
    sessionId?: string;
  }>();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const {
    visibleRightSession,
    replaceRightSession,
    placeCreatedSession,
    isRightSessionPending,
    lastActiveWorkspaceId,
  } = useKanbanSessionContext();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { projectId } = useProject();
  const { profiles, config } = useUserSystem();
  const effectiveProjectId = projectId ?? routeProjectId;
  const showRightSession = !!visibleRightSession;
  const rightSessionWorkspaceId = visibleRightSession?.workspaceId ?? '';
  const rightSessionId = visibleRightSession?.sessionId ?? '';
  const isWorkspaceRoute = effectiveActiveTab === 'workspace' && !!workspaceId;
  const fallbackWorkspaceId =
    activeWorktreeId ?? visibleRightSession?.workspaceId ?? workspaceId;
  const queryClient = useQueryClient();
  const { data: repos = [] } = useProjectRepos(effectiveProjectId);
  const primaryRepo = repos[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { worktrees, isLoading: isLoadingWorktrees } =
    useProjectWorktrees(effectiveProjectId);
  const { data: fallbackWorkspace } = useTaskAttempt(fallbackWorkspaceId);
  const { data: lastActiveWorkspace } = useTaskAttempt(
    lastActiveWorkspaceId ?? undefined
  );
  const preferredMainBranch = useMemo(
    () =>
      repos
        .map((repo) => repo.default_target_branch?.trim().toLowerCase() ?? '')
        .find((branch) => branch.length > 0) ?? null,
    [repos]
  );
  const createWorkspaceOptions = useMemo(() => {
    const baseWorkspaces = worktrees.map((item) => item.workspace);
    const nextWorkspaces: Workspace[] = [];

    [fallbackWorkspace, lastActiveWorkspace, ...baseWorkspaces].forEach(
      (workspace) => {
        if (!workspace) {
          return;
        }

        if (nextWorkspaces.some((candidate) => candidate.id === workspace.id)) {
          return;
        }

        nextWorkspaces.push(workspace);
      }
    );

    return nextWorkspaces;
  }, [fallbackWorkspace, lastActiveWorkspace, worktrees]);
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
  const defaultWorkspaceValue = useMemo(() => {
    const activeOption = findWorkspaceBranchOptionByWorkspaceId(
      workspaceBranchOptions,
      activeWorktreeId
    );
    if (activeOption) {
      return activeOption.value;
    }

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
  }, [
    activeWorktreeId,
    lastActiveWorkspaceId,
    mainlineWorkspaceValue,
    workspaceBranchOptions,
  ]);

  const canUseExistingWorkspace = workspaceBranchOptions.length > 0;

  const defaultExecutorProfile = useMemo<ExecutorProfileId | null>(
    () => config?.executor_profile ?? getFirstAvailableProfile(profiles),
    [config?.executor_profile, profiles]
  );
  const [isCreateOverlayOpen, setIsCreateOverlayOpen] = useState(false);
  const [createMode, setCreateMode] =
    useState<SessionCreationMode>('existing_workspace');
  const [createSessionName, setCreateSessionName] = useState('');
  const [createWorkspaceValue, setCreateWorkspaceValue] = useState(
    defaultWorkspaceValue
  );
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const {
    configs: repoBranchConfigs,
    isLoading: isLoadingRepoBranches,
    setRepoBranch,
    getWorkspaceRepoInputs,
    reset: resetRepoBranchSelection,
  } = useRepoBranchSelection({
    repos,
    enabled: isCreateOverlayOpen,
  });

  useEffect(() => {
    if (
      !createWorkspaceValue ||
      !workspaceBranchOptions.some(
        (option) => option.value === createWorkspaceValue
      )
    ) {
      setCreateWorkspaceValue(defaultWorkspaceValue);
    }
  }, [createWorkspaceValue, defaultWorkspaceValue, workspaceBranchOptions]);

  useEffect(() => {
    if (!isCreateOverlayOpen || isLoadingWorktrees) {
      return;
    }

    if (!canUseExistingWorkspace) {
      setCreateMode('new_workspace');
    }
  }, [canUseExistingWorkspace, isCreateOverlayOpen, isLoadingWorktrees]);

  useEffect(() => {
    if (selectedExecutorProfile) {
      return;
    }

    setSelectedExecutorProfile(defaultExecutorProfile);
  }, [defaultExecutorProfile, selectedExecutorProfile]);

  const selectedWorkspaceOption = useMemo<WorkspaceBranchOption | null>(
    () =>
      findWorkspaceBranchOption(workspaceBranchOptions, createWorkspaceValue),
    [createWorkspaceValue, workspaceBranchOptions]
  );
  const syncWorkspaceRouteSession = useCallback(
    (session: { sessionId: string; workspaceId: string }) => {
      if (activeWorktreeId !== session.workspaceId) {
        setActiveWorktree(session.workspaceId, null);
      }

      if (effectiveProjectId && isWorkspaceRoute) {
        navigate(
          paths.projectSession(
            effectiveProjectId,
            session.workspaceId,
            session.sessionId
          )
        );
      }
    },
    [
      activeWorktreeId,
      effectiveProjectId,
      isWorkspaceRoute,
      navigate,
      setActiveWorktree,
    ]
  );

  const handleCreatedSession = useCallback(
    (session: { sessionId: string; workspaceId: string }) => {
      placeCreatedSession(session);
      syncWorkspaceRouteSession(session);
    },
    [placeCreatedSession, syncWorkspaceRouteSession]
  );

  const handleSelectedSession = useCallback(
    (session: { sessionId: string; workspaceId: string }) => {
      replaceRightSession(session);
      syncWorkspaceRouteSession(session);
    },
    [replaceRightSession, syncWorkspaceRouteSession]
  );

  const canCreateSession =
    !!selectedExecutorProfile?.executor &&
    (createMode === 'existing_workspace'
      ? !!selectedWorkspaceOption
      : repos.length > 0 &&
        repoBranchConfigs.length > 0 &&
        repoBranchConfigs.every((repoConfig) => !!repoConfig.targetBranch));

  // Latest ACP control preset picked in the create form; materialized onto the
  // created conversation before navigation (ref: no re-render needed on pick).
  const sessionControlsPresetRef = useRef<SessionControlsPreset | null>(null);

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveProjectId) {
        throw new Error('Project is required');
      }

      const workspaceSelection =
        createMode === 'existing_workspace'
          ? resolveWorkspaceBranchSelection(selectedWorkspaceOption)
          : { workspaceId: null, branch: null };

      return sessionsApi.createProject({
        project_id: effectiveProjectId,
        workspace_id: workspaceSelection.workspaceId,
        branch: workspaceSelection.branch,
        executor: selectedExecutorProfile?.executor ?? undefined,
        name: createSessionName.trim() || null,
        create_workspace: createMode === 'new_workspace',
        repos:
          createMode === 'new_workspace' ? getWorkspaceRepoInputs() : undefined,
      });
    },
    onSuccess: async (newSession) => {
      if (selectedExecutorProfile?.executor) {
        let controlsInitialized = false;
        try {
          await initializeSessionControls(
            newSession.id,
            sessionControlsPresetRef.current
          );
          controlsInitialized = true;
        } catch (error) {
          console.warn(
            'Failed to initialize created session controls; preserving first-turn fallback',
            error
          );
        }
        try {
          await scratchApi.update(ScratchType.DRAFT_FOLLOW_UP, newSession.id, {
            payload: {
              type: 'DRAFT_FOLLOW_UP',
              data: {
                message: '',
                images: [],
                executor_config: selectedExecutorProfile,
                queued: false,
                mode_override: controlsInitialized
                  ? undefined
                  : (sessionControlsPresetRef.current?.modeOverride ??
                    undefined),
                config_overrides: controlsInitialized
                  ? {}
                  : (sessionControlsPresetRef.current?.configOverrides ?? {}),
              },
            },
          });
        } catch (error) {
          console.warn('Failed to persist created session profile', error);
        }
      }
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['taskAttempt', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['taskAttemptWithSession', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['projectWorktrees', effectiveProjectId],
      });
      if (primaryRepo?.id) {
        await queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepo.id],
        });
      }
      handleCreatedSession({
        sessionId: newSession.id,
        workspaceId: newSession.workspace_id,
      });
      setCreateSessionName('');
      setIsCreateOverlayOpen(false);
    },
  });

  const handleCreateOverlayOpenChange = useCallback(
    (open: boolean) => {
      setIsCreateOverlayOpen(open);

      if (open) {
        sessionControlsPresetRef.current = null;
        setCreateWorkspaceValue(defaultWorkspaceValue);
        setSelectedExecutorProfile(defaultExecutorProfile);
        setCreateSessionName('');
        setCreateMode(
          canUseExistingWorkspace ? 'existing_workspace' : 'new_workspace'
        );
        resetRepoBranchSelection();
        return;
      }

      createSessionMutation.reset();
    },
    [
      canUseExistingWorkspace,
      createSessionMutation,
      defaultExecutorProfile,
      defaultWorkspaceValue,
      resetRepoBranchSelection,
    ]
  );

  const openCreateSessionOverlay = useCallback(() => {
    handleCreateOverlayOpenChange(true);
  }, [handleCreateOverlayOpenChange]);

  // Stable props for the conversation view: the view mounts placement slots
  // from a useLayoutEffect keyed on these props — fresh object literals per
  // render would re-run that effect every render and, combined with the
  // placement provider's version bump, loop into "Maximum update depth".
  const workspaceConversationViewProps = useMemo(
    () => ({
      workspaceId: workspaceId!,
      sessionId,
      interactive: true,
      showSessionSelector: true,
      onSessionCreated: handleCreatedSession,
      onSessionSelected: handleSelectedSession,
      onCreateSessionRequested: openCreateSessionOverlay,
      className: 'h-full',
    }),
    [
      workspaceId,
      sessionId,
      handleCreatedSession,
      handleSelectedSession,
      openCreateSessionOverlay,
    ]
  );
  const rightSessionConversationViewProps = useMemo(
    () =>
      rightSessionWorkspaceId && rightSessionId
        ? {
            workspaceId: rightSessionWorkspaceId,
            sessionId: rightSessionId,
            interactive: true,
            showSessionSelector: true,
            onSessionCreated: handleCreatedSession,
            onSessionSelected: handleSelectedSession,
            onCreateSessionRequested: openCreateSessionOverlay,
            className: 'h-full',
          }
        : null,
    [
      handleCreatedSession,
      handleSelectedSession,
      openCreateSessionOverlay,
      rightSessionId,
      rightSessionWorkspaceId,
    ]
  );

  const handleSessionControlsPresetChange = useCallback(
    (preset: SessionControlsPreset | null) => {
      sessionControlsPresetRef.current = preset;
    },
    []
  );

  const overlayProps = {
    createMode,
    setCreateMode,
    workspaceBranchOptions,
    createWorkspaceValue,
    setCreateWorkspaceValue,
    createSessionName,
    setCreateSessionName,
    profiles,
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    repoBranchConfigs,
    setRepoBranch,
    isLoadingRepoBranches,
    canCreateSession,
    isCreatePending: createSessionMutation.isPending,
    createError: createSessionMutation.error,
    onSubmitCreate: async () => {
      if (
        createMode === 'new_workspace' &&
        effectiveProjectId &&
        !(await confirmWorktreeCreation(effectiveProjectId, t))
      ) {
        return;
      }
      createSessionMutation.mutate(undefined);
    },
    onClose: () => handleCreateOverlayOpenChange(false),
    onSessionControlsPresetChange: handleSessionControlsPresetChange,
  };

  return (
    <RightPanelSessionCreationProvider value={{ openCreateSessionOverlay }}>
      <div className="h-full flex overflow-hidden bg-transparent">
        <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
          <BranchInfoHeader />
          <div className="right-panel-conversation-region relative flex-1 min-h-0 overflow-hidden">
            {isWorkspaceRoute && workspaceId ? (
              <div className="h-full min-h-0 overflow-hidden">
                <KanbanSessionConversationView
                  {...workspaceConversationViewProps}
                />
              </div>
            ) : showRightSession &&
              visibleRightSession &&
              rightSessionConversationViewProps ? (
              <div className="h-full min-h-0 overflow-hidden">
                <KanbanSessionConversationView
                  {...rightSessionConversationViewProps}
                />
              </div>
            ) : isRightSessionPending ? (
              <div className="workspace-loading-state flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-sm">
                <Loader2 className="h-6 w-6 animate-spin" />
                <div className="workspace-loading-panel flex flex-col items-center gap-1 px-5 py-4">
                  <p className="font-medium text-foreground">Loading session</p>
                  <p className="text-xs text-muted-foreground">
                    Preparing the conversation panel...
                  </p>
                </div>
              </div>
            ) : (
              <RightPanelNewSessionPrompt
                onCreateSession={openCreateSessionOverlay}
              />
            )}

            {isCreateOverlayOpen ? (
              <CreateSessionOverlay {...overlayProps} />
            ) : null}
          </div>
        </div>
        {effectiveActiveTab === 'workspace' ? <RightPanelSidebar /> : null}
      </div>
    </RightPanelSessionCreationProvider>
  );
}
