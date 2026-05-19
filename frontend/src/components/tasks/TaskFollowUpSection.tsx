import { Loader2, ArrowUp, CheckSquare, X } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { BaseCodingAgent, ScratchType } from 'shared/types';
import {
  useBranchStatus,
  useProjectRepos,
  useProjectWorktrees,
  useRepoBranches,
  useRepoBranchSelection,
} from '@/hooks';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { cn } from '@/lib/utils';
import { useReview } from '@/contexts/ReviewProvider';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { useEntries } from '@/contexts/EntriesContext';
import { useTodos } from '@/hooks/useTodos';
import { useKeySubmitFollowUp, Scope } from '@/keyboard';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useProject } from '@/contexts/ProjectContext';
import { useUserSystem } from '@/components/ConfigProvider';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { FollowUpConflictSection } from '@/components/tasks/follow-up/FollowUpConflictSection';
import { buildClickedElementData } from '@/contexts/ClickedElementsProvider';
import type { ClickedElementData } from '@/components/ui/wysiwyg/nodes/clicked-element-node';
import WYSIWYGEditor, {
  SESSION_INPUT_EDITOR_CLASS_NAME,
  SESSION_INPUT_MARKDOWN_PRESET,
} from '@/components/ui/wysiwyg';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';
import { useGitStatus } from '@/hooks/git';

import type {
  DraftFollowUpData,
  ExecutorProfileId,
  ProviderRuntimeEvent,
  QueueStatus,
  Session,
} from 'shared/types';
import {
  getFirstAvailableProfile,
  getLatestProfileFromProcesses,
} from '@/utils/executor';
import { buildResolveConflictsInstructions } from '@/lib/conflicts';
import { buildPromptEnhancementContext } from '@/lib/promptEnhancement';
import { useScratch } from '@/hooks/useScratch';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queueApi, imagesApi, sessionsApi, configApi } from '@/lib/api';
import { buildAgentPrompt } from '@/utils/promptMessage';
import { toVibeImagePath } from '@/utils/images';
import { useTokenUsage } from '@/contexts/EntriesContext';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useRightPanelSessionCreation } from '@/contexts/RightPanelSessionCreationContext';
import { useParams } from 'react-router-dom';

import { DiffStatsBar } from './follow-up/DiffStatsBar';
import { CodexGoalIndicator } from './follow-up/CodexGoalIndicator';
import { TokenUsageIndicator } from './follow-up/TokenUsageIndicator';
import { SessionSelector } from './follow-up/SessionSelector';
import { ReviewCommentsPreview } from './follow-up/ReviewCommentsPreview';
import { MessageQueueIndicator } from './follow-up/MessageQueueIndicator';
import { ActionBar } from './follow-up/ActionBar';
import {
  SessionCreationForm,
  type SessionCreationMode,
} from '@/components/sessions/SessionCreationForm';
import {
  buildWorkspaceBranchOptions,
  findWorkspaceBranchOption,
  findWorkspaceBranchOptionByWorkspaceId,
  resolveWorkspaceBranchSelection,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import {
  codexGoalEntriesFromConversation,
  deriveCodexGoalState,
} from '@/lib/codexGoalState';
import { isContextCompactProcess } from '@/lib/contextCompact';
import { sendProviderRuntimeTurn } from '@/features/provider-runtime/sendProviderRuntimeTurn';

interface TaskFollowUpSectionProps {
  taskId?: string | null;
  session?: Session;
  workspaceId?: string;
  onJumpToPreviousUserMessage?: () => void;
  showSessionSelector?: boolean;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onSessionSelected?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  sessionState: Pick<
    UseWorkspaceSessionsResult,
    | 'sessions'
    | 'selectedSessionId'
    | 'selectSession'
    | 'selectLatestSession'
    | 'startNewSession'
    | 'isNewSessionMode'
  >;
}

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty' };

interface TodoItem {
  content: string;
  status: string;
}

function truncateSessionLabel(label: string, maxUnits = 8): string {
  if (!label) return '\u4f1a\u8bdd';

  let units = 0;
  let compact = '';

  for (const char of label) {
    const nextUnits = (char.codePointAt(0) ?? 0) > 255 ? 2 : 1;
    if (units + nextUnits > maxUnits) {
      break;
    }
    compact += char;
    units += nextUnits;
  }

  return compact || label;
}

function getProviderRuntimeExecutionProcessId(
  event: ProviderRuntimeEvent
): string | null {
  if (!event.event || typeof event.event !== 'object') return null;
  const value = (event.event as Record<string, unknown>).execution_process_id;
  return typeof value === 'string' && value.trim() ? value : null;
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
    return 'Unknown enhancement error';
  }
}

function getPromptEnhancementErrorMessage(error: unknown): string {
  const rawMessage = getErrorMessage(error).trim();
  const detail = rawMessage
    .replace(/^(Bad request|Internal error|Not found):\s*/i, '')
    .trim();

  if (/Prompt enhancement is disabled in system settings/i.test(detail)) {
    return '提示词优化失败：系统设置中已关闭提示词优化，请在设置中启用后重试。';
  }

  if (/Draft prompt cannot be empty/i.test(detail)) {
    return '提示词优化失败：提示词内容不能为空。';
  }

  if (/Prompt enhancement returned empty content/i.test(detail)) {
    return '提示词优化失败：模型返回了空内容，请重试或更换模型。';
  }

  if (/OpenCode CLI not found/i.test(detail)) {
    return '提示词优化失败：未找到 OpenCode CLI，请先安装或配置 OpenCode。';
  }

  if (
    /OpenCode response did not contain a valid EnhancedPrompt field/i.test(
      detail
    )
  ) {
    return '提示词优化失败：OpenCode 未返回有效的优化结果，请重试或更换模型。';
  }

  if (/OpenCode prompt enhancement failed/i.test(detail)) {
    return '提示词优化失败：OpenCode 执行失败，请检查模型配置或稍后重试。';
  }

  if (/OpenCode prompt enhancement timed out/i.test(detail)) {
    return '提示词优化失败：OpenCode 响应超时，请稍后重试或更换模型。';
  }

  if (/Failed to run OpenCode/i.test(detail)) {
    return '提示词优化失败：无法启动 OpenCode，请检查 OpenCode 是否可用。';
  }

  const normalizedDetail = detail || rawMessage || '未知错误';
  return `提示词优化失败：${normalizedDetail}`;
}

function TodoListButton({ todos }: { todos: TodoItem[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="任务列表"
          aria-label="任务列表"
          className={cn(
            'composer-control flex items-center justify-center rounded-md px-1.5 py-0.5 transition-colors',
            todos.length === 0 && 'opacity-50'
          )}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          {todos.length > 0 ? (
            <span className="ml-0.5 text-[10px] leading-none">
              {todos.length}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-2">
        {todos.length === 0 ? (
          <div className="py-2 text-center text-xs text-muted-foreground">
            暂无任务
          </div>
        ) : (
          <>
            <div className="mb-1.5 text-xs font-medium">
              任务列表 ({todos.length})
            </div>
            <ul className="max-h-48 space-y-1 overflow-auto">
              {todos.map((todo, index) => (
                <li key={index} className="flex items-start gap-1.5 text-xs">
                  <span
                    className={`mt-0.5 shrink-0 ${
                      todo.status === 'completed'
                        ? 'text-green-500'
                        : todo.status === 'in_progress' ||
                            todo.status === 'in-progress'
                          ? 'text-blue-500'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {todo.status === 'completed'
                      ? '\u2713'
                      : todo.status === 'in_progress' ||
                          todo.status === 'in-progress'
                        ? '\u25CF'
                        : '\u25CB'}
                  </span>
                  <span
                    className={
                      todo.status === 'cancelled'
                        ? 'line-through text-muted-foreground'
                        : ''
                    }
                  >
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TaskFollowUpSection({
  taskId,
  session,
  workspaceId: workspaceIdProp,
  onJumpToPreviousUserMessage,
  showSessionSelector = true,
  onSessionCreated,
  onSessionSelected,
  sessionState,
}: TaskFollowUpSectionProps) {
  const { projectId } = useProject();
  const { activeWorktreeId } = useWorktree();
  const rightPanelSessionCreation = useRightPanelSessionCreation();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const workspaceId =
    activeWorktreeId ??
    routeWorkspaceId ??
    workspaceIdProp ??
    session?.workspace_id ??
    null;
  const workspaceIdValue = workspaceId ?? undefined;
  const {
    sessions,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    startNewSession,
    isNewSessionMode,
  } = sessionState;
  const isNewSessionConfigVisible =
    isNewSessionMode && !rightPanelSessionCreation;
  const isAwaitingNewSessionConfirmation = false;
  const sessionId = isNewSessionMode ? undefined : session?.id;
  const { profiles, config } = useUserSystem();
  const selectedSessionSummary = sessions.find(
    (s) => s.id === selectedSessionId
  );
  const selectedSessionLabel = isNewSessionMode
    ? `\u4f1a\u8bdd${sessions.length + 1}`
    : selectedSessionSummary
      ? `${selectedSessionSummary.displayName} · ${selectedSessionSummary.continuityLabel}`
      : '\u4f1a\u8bdd';
  const compactSessionLabel = truncateSessionLabel(
    isNewSessionMode
      ? `\u4f1a\u8bdd${sessions.length + 1}`
      : (selectedSessionSummary?.displayName ?? '\u4f1a\u8bdd')
  );

  const { isAttemptRunning, stopExecution, isStopping, processes } =
    useAttemptExecution(workspaceIdValue, taskId ?? undefined);

  const { data: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus(workspaceIdValue);
  const { repos, selectedRepoId } = useAttemptRepo(workspaceIdValue);

  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) => r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );
  const { branch: attemptBranch, refetch: refetchAttemptBranch } =
    useAttemptBranch(workspaceIdValue);
  const { comments, generateReviewMarkdown, clearComments } = useReview();
  const { registerOnElementAdded, workspaceRoot } = useClickedElements();

  // Clicked element chip insertion bridge
  const insertClickedElementRef = useRef<
    ((data: ClickedElementData) => void) | null
  >(null);

  const handleRegisterClickedElementInsert = useCallback(
    (insertFn: (data: ClickedElementData) => void) => {
      insertClickedElementRef.current = insertFn;
    },
    []
  );

  useEffect(() => {
    const unregister = registerOnElementAdded((entry) => {
      const data = buildClickedElementData(entry, workspaceRoot);
      insertClickedElementRef.current?.(data);
    });
    return unregister;
  }, [registerOnElementAdded, workspaceRoot]);

  const { enableScope, disableScope } = useHotkeysContext();

  const tokenUsageInfo = useTokenUsage();
  const summaryRepoId = useMemo(() => {
    if (selectedRepoId && repos.some((repo) => repo.id === selectedRepoId)) {
      return selectedRepoId;
    }

    return repos[0]?.id ?? null;
  }, [repos, selectedRepoId]);
  const {
    stagedFiles: summaryStagedFiles,
    unstagedFiles: summaryUnstagedFiles,
    totalAdditions: added,
    totalDeletions: deleted,
  } = useGitStatus({
    workspaceId: workspaceId ?? null,
    repoId: summaryRepoId,
    pollMode: 'background',
  });
  const fileCount = useMemo(() => {
    const changedPaths = new Set<string>();
    for (const file of summaryStagedFiles) {
      changedPaths.add(file.path);
    }
    for (const file of summaryUnstagedFiles) {
      changedPaths.add(file.path);
    }
    return changedPaths.size;
  }, [summaryStagedFiles, summaryUnstagedFiles]);

  const reviewMarkdown = useMemo(
    () => generateReviewMarkdown(),
    [generateReviewMarkdown]
  );

  const conflictResolutionInstructions = useMemo(() => {
    if (!repoWithConflicts?.conflicted_files?.length) return null;
    return buildResolveConflictsInstructions(
      attemptBranch,
      repoWithConflicts.target_branch_name,
      repoWithConflicts.conflicted_files,
      repoWithConflicts.conflict_op ?? null,
      repoWithConflicts.repo_name
    );
  }, [attemptBranch, repoWithConflicts]);

  const scratchId = isNewSessionMode ? workspaceId : sessionId;
  const scratchIdValue = scratchId ?? undefined;

  const {
    scratch,
    updateScratch,
    deleteScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.DRAFT_FOLLOW_UP, scratchIdValue ?? '');

  const scratchData: DraftFollowUpData | undefined =
    scratch?.payload?.type === 'DRAFT_FOLLOW_UP'
      ? scratch.payload.data
      : undefined;
  const scratchExecutorProfile = useMemo(() => {
    const data = scratchData as
      | (DraftFollowUpData & {
          executor_config?: {
            executor: BaseCodingAgent;
            variant?: string | null;
            model?: string | null;
            model_id?: string | null;
          };
        })
      | undefined;

    const raw = data?.executor_config ?? data?.executor_profile_id;
    if (!raw?.executor) return null;
    const rawModel = raw as { model?: unknown; model_id?: unknown };
    const model =
      typeof rawModel.model === 'string'
        ? rawModel.model
        : typeof rawModel.model_id === 'string'
          ? rawModel.model_id
          : null;

    return {
      executor: raw.executor,
      variant: raw.variant ?? null,
      model,
    } satisfies ExecutorProfileId;
  }, [scratchData]);

  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const [localMessage, setLocalMessage] = useState('');
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionMode, setNewSessionMode] =
    useState<SessionCreationMode>('existing_workspace');
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const { data: projectRepos = [] } = useProjectRepos(projectId);
  const primaryRepo = projectRepos[0];
  const { data: primaryRepoBranches = [] } = useRepoBranches(primaryRepo?.id, {
    enabled: Boolean(primaryRepo?.id),
  });
  const { worktrees } = useProjectWorktrees(projectId);
  const createWorkspaceOptions = useMemo(
    () => worktrees.map((item) => item.workspace),
    [worktrees]
  );
  const workspaceBranchOptions = useMemo(
    () =>
      buildWorkspaceBranchOptions({
        workspaces: createWorkspaceOptions,
        repoBranches: primaryRepoBranches,
      }),
    [createWorkspaceOptions, primaryRepoBranches]
  );
  const defaultNewSessionWorkspaceValue = useMemo(() => {
    const currentWorkspaceOption = findWorkspaceBranchOptionByWorkspaceId(
      workspaceBranchOptions,
      workspaceId
    );
    if (currentWorkspaceOption) {
      return currentWorkspaceOption.value;
    }

    return workspaceBranchOptions[0]?.value ?? '';
  }, [workspaceBranchOptions, workspaceId]);
  const [newSessionWorkspaceValue, setNewSessionWorkspaceValue] = useState(
    defaultNewSessionWorkspaceValue
  );
  const {
    configs: newSessionRepoBranchConfigs,
    isLoading: isLoadingNewSessionBranches,
    setRepoBranch: setNewSessionRepoBranch,
    getWorkspaceRepoInputs: getNewSessionRepoInputs,
    reset: resetNewSessionRepoSelection,
  } = useRepoBranchSelection({
    repos: projectRepos,
    enabled: isNewSessionMode,
  });

  const latestProfileId = useMemo(
    () => getLatestProfileFromProcesses(processes),
    [processes]
  );
  const createdSessionProfilesRef = useRef<Record<string, ExecutorProfileId>>(
    {}
  );

  const defaultExecutorProfile = useMemo(() => {
    if (scratchExecutorProfile) return scratchExecutorProfile;
    if (latestProfileId) return latestProfileId;
    const createdSessionProfile = session?.id
      ? createdSessionProfilesRef.current[session.id]
      : null;
    if (createdSessionProfile) return createdSessionProfile;
    if (session?.executor) {
      return { executor: session.executor as BaseCodingAgent, variant: null };
    }
    if (config?.executor_profile) return config.executor_profile;
    return getFirstAvailableProfile(profiles);
  }, [
    scratchExecutorProfile,
    latestProfileId,
    session?.id,
    session?.executor,
    config?.executor_profile,
    profiles,
  ]);

  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const previousScratchIdRef = useRef<string | undefined>(scratchIdValue);

  useEffect(() => {
    const scratchChanged = previousScratchIdRef.current !== scratchIdValue;
    previousScratchIdRef.current = scratchIdValue;
    if (scratchChanged || !selectedExecutorProfile) {
      if (
        scratchChanged &&
        selectedExecutorProfile &&
        defaultExecutorProfile &&
        selectedExecutorProfile.executor === defaultExecutorProfile.executor &&
        selectedExecutorProfile.variant &&
        !defaultExecutorProfile.variant
      ) {
        return;
      }
      setSelectedExecutorProfile(defaultExecutorProfile);
    }
  }, [defaultExecutorProfile, selectedExecutorProfile, scratchIdValue]);

  const effectiveExecutorProfile =
    selectedExecutorProfile ?? defaultExecutorProfile;
  const executorProfileRef = useRef<ExecutorProfileId | null>(
    effectiveExecutorProfile
  );
  const previousExecutorProfileKeyRef = useRef<string | null>(null);
  useEffect(() => {
    executorProfileRef.current = effectiveExecutorProfile;
  }, [effectiveExecutorProfile]);

  const scratchRef = useRef(scratch);
  useEffect(() => {
    scratchRef.current = scratch;
  }, [scratch]);

  const saveToScratch = useCallback(
    async (message: string, executorProfileId: ExecutorProfileId | null) => {
      if (!workspaceId || !executorProfileId?.executor) return;
      if (
        !message.trim() &&
        !executorProfileId.variant &&
        !executorProfileId.model &&
        !scratchRef.current
      )
        return;
      try {
        await updateScratch({
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: {
              message,
              executor_profile_id: executorProfileId,
              queued: false,
            } as DraftFollowUpData,
          },
        });
      } catch (e) {
        console.error('Failed to save follow-up draft', e);
      }
    },
    [workspaceId, updateScratch]
  );

  const { debounced: setFollowUpMessage, cancel: cancelDebouncedSave } =
    useDebouncedCallback(
      useCallback(
        (value: string) => saveToScratch(value, executorProfileRef.current),
        [saveToScratch]
      ),
      500
    );

  useEffect(() => {
    const profileKey = effectiveExecutorProfile
      ? `${effectiveExecutorProfile.executor}:${effectiveExecutorProfile.variant ?? 'DEFAULT'}:${effectiveExecutorProfile.model ?? 'DEFAULT'}`
      : null;
    if (previousExecutorProfileKeyRef.current === profileKey) return;
    previousExecutorProfileKeyRef.current = profileKey;
    if (!isScratchLoading) {
      void saveToScratch(localMessage, effectiveExecutorProfile);
    }
  }, [effectiveExecutorProfile, isScratchLoading, localMessage, saveToScratch]);

  const hydratedScratchIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (isScratchLoading) return;
    if (hydratedScratchIdRef.current === scratchIdValue) return;
    hydratedScratchIdRef.current = scratchIdValue;
    setLocalMessage(scratchData?.message ?? '');
  }, [isScratchLoading, scratchData?.message, scratchIdValue]);

  const { activeRetryProcessId } = useRetryUi();
  const isRetryActive = !!activeRetryProcessId;

  const queryClient = useQueryClient();
  const QUEUE_STATUS_KEY = 'queue-status';
  const handleRenameSession = useCallback(
    async (targetSessionId: string, name: string | null) => {
      await sessionsApi.rename(targetSessionId, name);
      if (workspaceId) {
        await queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        });
      }
      queryClient.invalidateQueries({
        queryKey: ['session', targetSessionId],
      });
    },
    [queryClient, workspaceId]
  );

  const {
    data: queueStatus = { status: 'empty' as const },
    refetch: refreshQueueStatus,
  } = useQuery<QueueStatus>({
    queryKey: [QUEUE_STATUS_KEY, sessionId],
    queryFn: () =>
      sessionId
        ? queueApi.getStatus(sessionId)
        : Promise.resolve(EMPTY_QUEUE_STATUS),
    enabled: !!sessionId,
  });

  const isQueued = queueStatus.status === 'queued';
  const queuedMessage = isQueued
    ? (queueStatus as Extract<QueueStatus, { status: 'queued' }>).message
    : null;
  const hasVisibleQueuedMessage = isAttemptRunning && !!queuedMessage;

  const queueMutation = useMutation({
    mutationFn: ({
      message,
      executor_profile_id,
    }: {
      message: string;
      executor_profile_id: ExecutorProfileId;
    }) => queueApi.queue(sessionId!, { message, executor_profile_id }),
    onSuccess: (status) => {
      queryClient.setQueryData([QUEUE_STATUS_KEY, sessionId], status);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => queueApi.cancel(sessionId!),
    onSuccess: (status) => {
      queryClient.setQueryData([QUEUE_STATUS_KEY, sessionId], status);
    },
  });

  const queueMessage = useCallback(
    async (message: string, executorProfileId: ExecutorProfileId) => {
      if (!sessionId) return;
      await queueMutation.mutateAsync({
        message,
        executor_profile_id: executorProfileId,
      });
    },
    [sessionId, queueMutation]
  );

  const cancelQueue = useCallback(async () => {
    if (!sessionId) return;
    await cancelMutation.mutateAsync();
  }, [sessionId, cancelMutation]);

  const isQueueLoading = queueMutation.isPending || cancelMutation.isPending;

  const prevProcessCountRef = useRef(processes.length);
  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;
    if (!workspaceId) return;
    if (!isAttemptRunning) {
      refreshQueueStatus();
      return;
    }
    if (processes.length > prevCount) {
      refreshQueueStatus();
    }
  }, [isAttemptRunning, workspaceId, processes.length, refreshQueueStatus]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshQueueStatus();
  }, [refreshQueueStatus, sessionId]);

  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      selectSession(nextSessionId);
      if (workspaceId) {
        onSessionSelected?.({
          sessionId: nextSessionId,
          workspaceId,
        });
      }
    },
    [onSessionSelected, selectSession, workspaceId]
  );
  const rememberCreatedSessionProfile = useCallback(
    (sessionId: string, profile: ExecutorProfileId | null) => {
      if (!profile?.executor) return;
      createdSessionProfilesRef.current[sessionId] = profile;
    },
    []
  );
  const handleFollowUpSessionCreated = useCallback(
    (createdSession: { sessionId: string; workspaceId: string }) => {
      rememberCreatedSessionProfile(
        createdSession.sessionId,
        effectiveExecutorProfile
      );
      onSessionCreated?.(createdSession);
    },
    [effectiveExecutorProfile, onSessionCreated, rememberCreatedSessionProfile]
  );

  const { entries } = useEntries();
  const codexGoalState = useMemo(() => {
    if (effectiveExecutorProfile?.executor !== BaseCodingAgent.CODEX) {
      return null;
    }

    return deriveCodexGoalState(codexGoalEntriesFromConversation(entries));
  }, [effectiveExecutorProfile?.executor, entries]);
  const promptEnhancementContext = useMemo(
    () => buildPromptEnhancementContext(entries),
    [entries]
  );
  const { todos } = useTodos(entries);
  const hasPendingApproval = useMemo(() => {
    return entries.some((entry) => {
      if (entry.type !== 'NORMALIZED_ENTRY') return false;
      const entryType = entry.content.entry_type;
      return (
        entryType.type === 'tool_use' &&
        entryType.status.status === 'pending_approval'
      );
    });
  }, [entries]);

  const { isSendingFollowUp, followUpError, setFollowUpError, onSendFollowUp } =
    useFollowUpSend({
      sessionId,
      sessionExecutor: session?.executor,
      workspaceId: workspaceIdValue,
      isNewSessionMode,
      newSessionName,
      onSelectSession: handleSelectSession,
      onSessionCreated: handleFollowUpSessionCreated,
      message: localMessage,
      conflictMarkdown: conflictResolutionInstructions,
      reviewMarkdown,
      executorProfileId: effectiveExecutorProfile,
      clearComments,
      onAfterSendCleanup: async () => {
        cancelDebouncedSave();
        setLocalMessage('');
        setNewSessionName('');
        hydratedScratchIdRef.current = scratchIdValue;
        if (scratchIdValue) {
          await deleteScratch();
        }
      },
    });
  const [pendingCompactProcessId, setPendingCompactProcessId] = useState<
    string | null
  >(null);
  const isCompactProcessRunning = useMemo(
    () =>
      processes.some(
        (process) =>
          process.status === 'running' && isContextCompactProcess(process)
      ),
    [processes]
  );
  useEffect(() => {
    if (!pendingCompactProcessId) return;
    if (processes.some((process) => process.id === pendingCompactProcessId)) {
      setPendingCompactProcessId(null);
    }
  }, [pendingCompactProcessId, processes]);
  useEffect(() => {
    if (!pendingCompactProcessId) return;

    const timeout = window.setTimeout(() => {
      setPendingCompactProcessId((current) =>
        current === pendingCompactProcessId ? null : current
      );
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [pendingCompactProcessId]);
  const isCompactingContext =
    pendingCompactProcessId !== null || isCompactProcessRunning;

  const canTypeFollowUp = useMemo(() => {
    if (!workspaceId || isSendingFollowUp) return false;
    if (isRetryActive) return false;
    if (hasPendingApproval) return false;
    if (isCompactingContext) return false;
    return true;
  }, [
    workspaceId,
    isSendingFollowUp,
    isRetryActive,
    hasPendingApproval,
    isCompactingContext,
  ]);

  const canSendFollowUp = useMemo(() => {
    if (!canTypeFollowUp || !effectiveExecutorProfile?.executor) return false;
    if (isAwaitingNewSessionConfirmation || isNewSessionMode) return false;
    return Boolean(
      conflictResolutionInstructions || reviewMarkdown || localMessage.trim()
    );
  }, [
    canTypeFollowUp,
    isAwaitingNewSessionConfirmation,
    isNewSessionMode,
    effectiveExecutorProfile?.executor,
    conflictResolutionInstructions,
    reviewMarkdown,
    localMessage,
  ]);
  const canEnhancePrompt = useMemo(
    () => Boolean(canTypeFollowUp && localMessage.trim()),
    [canTypeFollowUp, localMessage]
  );
  const isEditable =
    !isRetryActive && !hasPendingApproval && !isCompactingContext;
  const canCompactContext = useMemo(() => {
    if (!sessionId || !workspaceIdValue || !effectiveExecutorProfile?.executor)
      return false;
    if (!canTypeFollowUp || isAttemptRunning) return false;
    if (isAwaitingNewSessionConfirmation || isNewSessionMode) return false;
    return true;
  }, [
    sessionId,
    workspaceIdValue,
    effectiveExecutorProfile?.executor,
    canTypeFollowUp,
    isAttemptRunning,
    isAwaitingNewSessionConfirmation,
    isNewSessionMode,
  ]);

  const handleQueueMessage = useCallback(async () => {
    if (
      !localMessage.trim() &&
      !conflictResolutionInstructions &&
      !reviewMarkdown
    )
      return;
    cancelDebouncedSave();
    await saveToScratch(localMessage, effectiveExecutorProfile);
    const { prompt } = buildAgentPrompt(
      localMessage,
      [conflictResolutionInstructions, reviewMarkdown].filter(Boolean)
    );
    if (effectiveExecutorProfile) {
      await queueMessage(prompt, effectiveExecutorProfile);
    }
  }, [
    localMessage,
    conflictResolutionInstructions,
    reviewMarkdown,
    effectiveExecutorProfile,
    queueMessage,
    cancelDebouncedSave,
    saveToScratch,
  ]);

  const handleCompactContext = useCallback(async () => {
    if (
      !sessionId ||
      !workspaceIdValue ||
      !effectiveExecutorProfile ||
      !canCompactContext
    )
      return;

    try {
      setFollowUpError(null);

      const event = await sendProviderRuntimeTurn({
        workspaceId: workspaceIdValue,
        sessionId,
        executorProfileId: effectiveExecutorProfile,
        text: '/compact',
      });
      setPendingCompactProcessId(getProviderRuntimeExecutionProcessId(event));
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      setFollowUpError(`启动上下文压缩失败：${message}`);
    }
  }, [
    canCompactContext,
    effectiveExecutorProfile,
    sessionId,
    setFollowUpError,
    workspaceIdValue,
  ]);

  const handleSubmitShortcut = useCallback(
    (e?: KeyboardEvent) => {
      e?.preventDefault();
      if (isAttemptRunning) {
        if (!isQueued) handleQueueMessage();
      } else {
        onSendFollowUp();
      }
    },
    [isAttemptRunning, isQueued, handleQueueMessage, onSendFollowUp]
  );

  const setFollowUpMessageRef = useRef(setFollowUpMessage);
  useEffect(() => {
    setFollowUpMessageRef.current = setFollowUpMessage;
  }, [setFollowUpMessage]);

  const followUpErrorRef = useRef(followUpError);
  useEffect(() => {
    followUpErrorRef.current = followUpError;
  }, [followUpError]);

  const getQueueState = useCallback(() => {
    const status = queryClient.getQueryData<QueueStatus>([
      QUEUE_STATUS_KEY,
      sessionId,
    ]);
    const queued = status?.status === 'queued';
    const message = queued
      ? (status as Extract<QueueStatus, { status: 'queued' }>).message
      : null;
    return { isQueued: queued, queuedMessage: message };
  }, [queryClient, sessionId]);

  const handlePasteFiles = useCallback(
    async (files: File[]) => {
      if (!workspaceId) return;
      for (const file of files) {
        try {
          const response = await imagesApi.uploadForAttempt(workspaceId, file);
          const imageMarkdown = `![${response.original_name}](${toVibeImagePath(response.file_path)})`;
          const {
            isQueued: currentlyQueued,
            queuedMessage: currentQueuedMessage,
          } = getQueueState();
          if (currentlyQueued && currentQueuedMessage) {
            cancelMutation.mutate();
            const base = currentQueuedMessage.data.message;
            const newMessage = base
              ? `${base}\n\n${imageMarkdown}`
              : imageMarkdown;
            setLocalMessage(newMessage);
            setFollowUpMessageRef.current(newMessage);
          } else {
            setLocalMessage((prev) => {
              const newMessage = prev
                ? `${prev}\n\n${imageMarkdown}`
                : imageMarkdown;
              setFollowUpMessageRef.current(newMessage);
              return newMessage;
            });
          }
        } catch (error) {
          console.error('Failed to upload image:', error);
        }
      }
    },
    [workspaceId, getQueueState, cancelMutation]
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      const { isQueued: currentlyQueued } = getQueueState();
      if (currentlyQueued) cancelMutation.mutate();
      setLocalMessage(value);
      setFollowUpMessageRef.current(value);
      if (followUpErrorRef.current) setFollowUpError(null);
    },
    [setFollowUpError, getQueueState, cancelMutation]
  );

  const handleEnhancePrompt = useCallback(async () => {
    if (isEnhancingPrompt) return;
    if (!localMessage.trim()) return;

    setIsEnhancingPrompt(true);
    setFollowUpError(null);

    try {
      const result = await configApi.enhancePrompt({
        draftPrompt: localMessage,
        sessionId: sessionId ?? null,
        workspaceId: workspaceId ?? null,
        contextMessages: promptEnhancementContext,
      });

      const enhancedPrompt = result.enhancedPrompt.trim();
      if (!enhancedPrompt) {
        throw new Error('Prompt enhancement returned empty content');
      }

      handleEditorChange(enhancedPrompt);
    } catch (error) {
      setFollowUpError(getPromptEnhancementErrorMessage(error));
    } finally {
      setIsEnhancingPrompt(false);
    }
  }, [
    isEnhancingPrompt,
    localMessage,
    sessionId,
    workspaceId,
    promptEnhancementContext,
    handleEditorChange,
    setFollowUpError,
  ]);

  useKeySubmitFollowUp(handleSubmitShortcut, {
    scope: Scope.FOLLOW_UP_READY,
    enableOnFormTags: ['textarea', 'TEXTAREA'],
    when: canSendFollowUp && isEditable,
  });

  useEffect(() => {
    if (isEditable && isTextareaFocused) {
      enableScope(Scope.FOLLOW_UP);
    } else {
      disableScope(Scope.FOLLOW_UP);
    }
    return () => {
      disableScope(Scope.FOLLOW_UP);
    };
  }, [isEditable, isTextareaFocused, enableScope, disableScope]);

  useEffect(() => {
    const isReady = isTextareaFocused && isEditable;
    if (isReady) {
      enableScope(Scope.FOLLOW_UP_READY);
    } else {
      disableScope(Scope.FOLLOW_UP_READY);
    }
    return () => {
      disableScope(Scope.FOLLOW_UP_READY);
    };
  }, [isTextareaFocused, isEditable, enableScope, disableScope]);

  const prevRunningRef = useRef<boolean>(isAttemptRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isAttemptRunning && workspaceId) {
      refetchBranchStatus();
      refetchAttemptBranch();
    }
    prevRunningRef.current = isAttemptRunning;
  }, [
    isAttemptRunning,
    workspaceId,
    refetchBranchStatus,
    refetchAttemptBranch,
  ]);

  useEffect(() => {
    if (!isNewSessionConfigVisible) {
      setNewSessionName('');
    }
  }, [isNewSessionConfigVisible, workspaceId]);
  useEffect(() => {
    if (
      !newSessionWorkspaceValue ||
      !workspaceBranchOptions.some(
        (option) => option.value === newSessionWorkspaceValue
      )
    ) {
      setNewSessionWorkspaceValue(defaultNewSessionWorkspaceValue);
    }
  }, [
    defaultNewSessionWorkspaceValue,
    newSessionWorkspaceValue,
    workspaceBranchOptions,
  ]);
  const selectedWorkspaceOption = useMemo<WorkspaceBranchOption | null>(
    () =>
      findWorkspaceBranchOption(
        workspaceBranchOptions,
        newSessionWorkspaceValue
      ),
    [newSessionWorkspaceValue, workspaceBranchOptions]
  );

  const handleCancelNewSession = useCallback(() => {
    selectLatestSession();
    setNewSessionName('');
    setNewSessionWorkspaceValue(defaultNewSessionWorkspaceValue);
    setNewSessionMode(
      workspaceBranchOptions.length > 0 ? 'existing_workspace' : 'new_workspace'
    );
    resetNewSessionRepoSelection();
    setSelectedExecutorProfile(defaultExecutorProfile);
  }, [
    defaultNewSessionWorkspaceValue,
    defaultExecutorProfile,
    resetNewSessionRepoSelection,
    selectLatestSession,
    workspaceBranchOptions.length,
  ]);

  const canCreateSessionDirectly =
    !!effectiveExecutorProfile?.executor &&
    (newSessionMode === 'existing_workspace'
      ? !!selectedWorkspaceOption
      : projectRepos.length > 0 &&
        newSessionRepoBranchConfigs.length > 0 &&
        newSessionRepoBranchConfigs.every((config) => !!config.targetBranch));

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) {
        throw new Error('Project is required');
      }

      const workspaceSelection =
        newSessionMode === 'existing_workspace'
          ? resolveWorkspaceBranchSelection(selectedWorkspaceOption)
          : { workspaceId: null, branch: null };

      return sessionsApi.createProject({
        project_id: projectId,
        workspace_id: workspaceSelection.workspaceId,
        branch: workspaceSelection.branch,
        executor: effectiveExecutorProfile?.executor ?? undefined,
        name: newSessionName.trim() || null,
        create_workspace: newSessionMode === 'new_workspace',
        repos:
          newSessionMode === 'new_workspace'
            ? getNewSessionRepoInputs()
            : undefined,
      });
    },
    onSuccess: async (newSession) => {
      await queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['taskAttempt', newSession.workspace_id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['taskAttemptWithSession', newSession.workspace_id],
      });
      if (projectId) {
        await queryClient.invalidateQueries({
          queryKey: ['projectWorktrees', projectId],
        });
      }
      if (primaryRepo?.id) {
        await queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepo.id],
        });
      }
      rememberCreatedSessionProfile(newSession.id, effectiveExecutorProfile);
      setSelectedExecutorProfile(effectiveExecutorProfile);
      onSessionCreated?.({
        sessionId: newSession.id,
        workspaceId: newSession.workspace_id,
      });
      if (newSession.workspace_id === workspaceId) {
        handleSelectSession(newSession.id);
      }
      setNewSessionName('');
    },
  });

  if (!workspaceId) return null;

  if (isScratchLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin h-6 w-6" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'flex min-h-0 flex-col overflow-hidden',
          isRetryActive && 'opacity-50'
        )}
      >
        {/* Scrollable content area */}
        <div className="min-h-0 overflow-y-auto px-3">
          <div className="space-y-2">
            {followUpError && (
              <div className="px-1 text-[11px] leading-4 text-muted-foreground">
                {followUpError}
              </div>
            )}
            <div className="space-y-2">
              <ReviewCommentsPreview reviewMarkdown={reviewMarkdown} />

              {branchStatus && (
                <FollowUpConflictSection
                  workspaceId={workspaceId}
                  attemptBranch={attemptBranch}
                  branchStatus={branchStatus}
                  isEditable={isEditable}
                  onResolve={onSendFollowUp}
                  enableResolve={
                    canSendFollowUp && !isAttemptRunning && isEditable
                  }
                  enableAbort={canSendFollowUp && !isAttemptRunning}
                  conflictResolutionInstructions={
                    conflictResolutionInstructions
                  }
                />
              )}

              <MessageQueueIndicator
                isQueued={hasVisibleQueuedMessage}
                messagePreview={
                  hasVisibleQueuedMessage
                    ? (queuedMessage?.data.message ?? null)
                    : null
                }
              />
            </div>
          </div>
        </div>

        {/* Input area with buttons inside */}
        <div
          className="composer-shell mx-3 mb-3 flex shrink-0 flex-col gap-1 overflow-hidden rounded-xl p-2"
          data-typeahead-surface="composer"
          onFocus={() => setIsTextareaFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setIsTextareaFocused(false);
            }
          }}
        >
          {/* Top bar */}
          {(tokenUsageInfo ||
            codexGoalState ||
            (showSessionSelector && sessions.length > 0) ||
            effectiveExecutorProfile?.executor) && (
            <div className="composer-topbar flex items-center gap-2 px-1 pb-2 text-xs">
              <DiffStatsBar
                executorProfile={effectiveExecutorProfile}
                sessionExecutor={session?.executor}
              />
              {fileCount > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="composer-control inline-flex items-center rounded-md px-2 py-0.5 text-[11px]">
                      {`${fileCount} 个文件更改`}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-green-600 dark:text-green-400">
                        +{added}
                      </span>
                      <span className="text-red-600 dark:text-red-400">
                        -{deleted}
                      </span>
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : null}

              <div className="flex-1" />

              <CodexGoalIndicator goalState={codexGoalState} />

              <TokenUsageIndicator tokenUsageInfo={tokenUsageInfo} />

              <TodoListButton todos={todos} />

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onJumpToPreviousUserMessage}
                    className="composer-control flex items-center justify-center rounded-md px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={
                      '\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f'
                    }
                    disabled={!onJumpToPreviousUserMessage}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {'\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f'}
                </TooltipContent>
              </Tooltip>

              {showSessionSelector ? (
                <SessionSelector
                  sessions={sessions}
                  selectedSessionId={selectedSessionId}
                  compactSessionLabel={compactSessionLabel}
                  selectedSessionLabel={selectedSessionLabel}
                  onSelectSession={handleSelectSession}
                  onStartNewSession={() => {
                    if (rightPanelSessionCreation) {
                      rightPanelSessionCreation.openCreateSessionOverlay();
                      return;
                    }

                    startNewSession();
                  }}
                  onRenameSession={handleRenameSession}
                  dropdownSide="top"
                />
              ) : null}
            </div>
          )}

          {isNewSessionConfigVisible ? (
            <div className="composer-config-panel rounded-xl p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-foreground">
                  {'\u65b0\u5efa\u4f1a\u8bdd\u914d\u7f6e'}
                </div>
                <button
                  type="button"
                  onClick={handleCancelNewSession}
                  className="composer-control inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                  aria-label="取消新建会话"
                  title="取消新建会话"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <SessionCreationForm
                mode={newSessionMode}
                onModeChange={setNewSessionMode}
                workspaceBranchOptions={workspaceBranchOptions}
                selectedWorkspaceValue={newSessionWorkspaceValue}
                onSelectedWorkspaceValueChange={setNewSessionWorkspaceValue}
                sessionName={newSessionName}
                onSessionNameChange={setNewSessionName}
                profiles={profiles}
                selectedExecutorProfile={effectiveExecutorProfile}
                onSelectedExecutorProfileChange={setSelectedExecutorProfile}
                repoBranchConfigs={newSessionRepoBranchConfigs}
                onRepoBranchChange={setNewSessionRepoBranch}
                isLoadingBranches={isLoadingNewSessionBranches}
                canSubmit={canCreateSessionDirectly}
                isSubmitting={createSessionMutation.isPending}
                errorMessage={
                  createSessionMutation.error
                    ? getSessionUiErrorMessage(
                        createSessionMutation.error,
                        '创建会话失败，请稍后重试。'
                      )
                    : null
                }
                onSubmit={() => createSessionMutation.mutate()}
                onCancel={handleCancelNewSession}
                compact
                dropdownSide="top"
              />
            </div>
          ) : null}

          <WYSIWYGEditor
            placeholder=""
            value={localMessage}
            onChange={handleEditorChange}
            disabled={!isEditable}
            onPasteFiles={handlePasteFiles}
            repoIds={repos.map((r) => r.id)}
            projectId={projectId}
            executorProfile={effectiveExecutorProfile}
            taskAttemptId={workspaceId}
            onCmdEnter={handleSubmitShortcut}
            sendShortcut={config?.send_message_shortcut}
            className={SESSION_INPUT_EDITOR_CLASS_NAME}
            onRegisterClickedElementInsert={handleRegisterClickedElementInsert}
            enableFloatingToolbar={false}
            markdownPreset={SESSION_INPUT_MARKDOWN_PRESET}
          />

          <ActionBar
            profiles={profiles}
            effectiveExecutorProfile={effectiveExecutorProfile}
            onChangeExecutorProfile={setSelectedExecutorProfile}
            showProfileControls={!isNewSessionConfigVisible}
            isEditable={isEditable}
            isAttemptRunning={isAttemptRunning}
            isQueued={hasVisibleQueuedMessage}
            isQueueLoading={isQueueLoading}
            canCompactContext={canCompactContext}
            isCompactingContext={isCompactingContext}
            isStopping={isStopping}
            isSendingFollowUp={isSendingFollowUp}
            canSendFollowUp={canSendFollowUp}
            isAwaitingNewSessionConfirmation={isAwaitingNewSessionConfirmation}
            promptEnhancementEnabled={
              config?.prompt_enhancement_enabled ?? false
            }
            isEnhancingPrompt={isEnhancingPrompt}
            canEnhancePrompt={canEnhancePrompt}
            sessionId={sessionId}
            localMessage={localMessage}
            conflictResolutionInstructions={conflictResolutionInstructions}
            reviewMarkdown={reviewMarkdown}
            todos={todos}
            comments={comments}
            onCompactContext={handleCompactContext}
            onQueueMessage={handleQueueMessage}
            onCancelQueue={cancelQueue}
            onStopExecution={stopExecution}
            onSendFollowUp={onSendFollowUp}
            onEnhancePrompt={handleEnhancePrompt}
            onClearComments={clearComments}
            onPasteFiles={handlePasteFiles}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
