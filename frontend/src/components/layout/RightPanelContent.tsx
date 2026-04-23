import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Outlet, useParams } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
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
import { sessionsApi } from '@/lib/api';
import {
  buildWorkspaceBranchOptions,
  findWorkspaceBranchOption,
  findWorkspaceBranchOptionByWorkspaceId,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';
import { getFirstAvailableProfile } from '@/utils/executor';
import { Loader2, Plus, X } from 'lucide-react';
import {
  SessionCreationForm,
  type SessionCreationMode,
} from '@/components/sessions/SessionCreationForm';
import type { ExecutorProfileId, Workspace } from 'shared/types';

const MAINLINE_BRANCH_NAMES = new Set(['main', 'master']);

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return '创建会话失败，请稍后重试。';
  }
}

export function RightPanelContent() {
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

  const canCreateSession =
    !!selectedExecutorProfile?.executor &&
    (createMode === 'existing_workspace'
      ? !!selectedWorkspaceOption
      : repos.length > 0 &&
        repoBranchConfigs.length > 0 &&
        repoBranchConfigs.every((config) => !!config.targetBranch));

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveProjectId) {
        throw new Error('Project is required');
      }

      return sessionsApi.createProject({
        project_id: effectiveProjectId,
        workspace_id:
          createMode === 'existing_workspace'
            ? selectedWorkspaceOption?.useWorktree
              ? selectedWorkspaceOption.existingWorkspaceId
              : null
            : null,
        branch:
          createMode === 'existing_workspace' &&
          !selectedWorkspaceOption?.useWorktree
            ? (selectedWorkspaceOption?.branch ?? null)
            : null,
        executor: selectedExecutorProfile?.executor ?? undefined,
        name: createSessionName.trim() || null,
        create_workspace: createMode === 'new_workspace',
        repos:
          createMode === 'new_workspace' ? getWorkspaceRepoInputs() : undefined,
      });
    },
    onSuccess: async (newSession) => {
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['projectWorktrees', effectiveProjectId],
      });
      if (primaryRepo?.id) {
        await queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepo.id],
        });
      }
      if (createMode === 'new_workspace') {
        setActiveWorktree(newSession.workspace_id, newSession.task_id ?? null);
      }
      placeCreatedSession({
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
      createSessionMutation,
      canUseExistingWorkspace,
      defaultExecutorProfile,
      defaultWorkspaceValue,
      resetRepoBranchSelection,
    ]
  );

  return (
    <div className="h-full flex overflow-hidden bg-background">
      <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
        <BranchInfoHeader />
        {showRightSession && visibleRightSession ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <KanbanSessionConversationView
              workspaceId={visibleRightSession.workspaceId}
              sessionId={visibleRightSession.sessionId}
              interactive={true}
              showSessionSelector={true}
              onSessionCreated={replaceRightSession}
              onSessionSelected={replaceRightSession}
              className="h-full"
            />
          </div>
        ) : effectiveActiveTab === 'workspace' && workspaceId ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Outlet />
          </div>
        ) : isRightSessionPending ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Loading session...</p>
          </div>
        ) : (
          <div className="relative flex flex-1 min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">创建新会话开始工作</p>
            <Button
              className="flex items-center gap-1.5 text-sm"
              onClick={() => handleCreateOverlayOpenChange(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              新建会话
            </Button>

            {isCreateOverlayOpen ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/86 p-6 backdrop-blur-sm">
                <div className="relative w-full max-w-[360px] rounded-xl border border-border bg-background p-4 shadow-xl">
                  <button
                    className="absolute right-2 top-2 z-10 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    onClick={() => handleCreateOverlayOpenChange(false)}
                  >
                    <X className="h-4 w-4" />
                    <span className="sr-only">关闭</span>
                  </button>
                  <div className="mb-4 space-y-1">
                    <div className="text-sm font-semibold text-foreground">
                      新建会话
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
                    canSubmit={canCreateSession}
                    isSubmitting={createSessionMutation.isPending}
                    errorMessage={
                      createSessionMutation.error
                        ? getErrorMessage(createSessionMutation.error)
                        : null
                    }
                    onSubmit={() => createSessionMutation.mutate()}
                    onCancel={() => handleCreateOverlayOpenChange(false)}
                    dropdownSide="top"
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {effectiveActiveTab === 'workspace' ? <RightPanelSidebar /> : null}
    </div>
  );
}
