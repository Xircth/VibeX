import { Loader2, AlertCircle, ArrowUp, Check, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ScratchType, type TaskWithAttemptStatus } from 'shared/types';
import { useBranchStatus } from '@/hooks';
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
import { Input } from '@/components/ui/input';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { FollowUpConflictSection } from '@/components/tasks/follow-up/FollowUpConflictSection';
import { buildClickedElementData } from '@/contexts/ClickedElementsProvider';
import type { ClickedElementData } from '@/components/ui/wysiwyg/nodes/clicked-element-node';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';
import { useDiffSummary } from '@/hooks/useDiffSummary';

import type {
  BaseCodingAgent,
  DraftFollowUpData,
  ExecutorProfileId,
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
import { useTokenUsage } from '@/contexts/EntriesContext';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';

import { DiffStatsBar } from './follow-up/DiffStatsBar';
import { TokenUsageIndicator } from './follow-up/TokenUsageIndicator';
import { SessionSelector } from './follow-up/SessionSelector';
import { ReviewCommentsPreview } from './follow-up/ReviewCommentsPreview';
import { MessageQueueIndicator } from './follow-up/MessageQueueIndicator';
import { ActionBar } from './follow-up/ActionBar';
import { TerminalProfileControls } from './TerminalProfileControls';

interface TaskFollowUpSectionProps {
  task: TaskWithAttemptStatus;
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
    | 'requestNewSession'
    | 'confirmNewSession'
    | 'cancelNewSession'
    | 'isPendingNewSessionMode'
    | 'isNewSessionMode'
  >;
}

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty' };

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

export function TaskFollowUpSection({
  task,
  session,
  workspaceId: workspaceIdProp,
  onJumpToPreviousUserMessage,
  showSessionSelector = true,
  onSessionCreated,
  onSessionSelected,
  sessionState,
}: TaskFollowUpSectionProps) {
  const { projectId } = useProject();
  const workspaceId = session?.workspace_id ?? workspaceIdProp;
  const {
    sessions,
    selectedSessionId,
    selectSession,
    requestNewSession,
    confirmNewSession,
    cancelNewSession,
    isPendingNewSessionMode,
    isNewSessionMode,
  } = sessionState;
  const isNewSessionConfigVisible =
    isNewSessionMode || isPendingNewSessionMode;
  const isAwaitingNewSessionConfirmation =
    isPendingNewSessionMode && !isNewSessionMode;
  const sessionId = isNewSessionMode ? undefined : session?.id;
  const { profiles, config } = useUserSystem();
  const selectedSessionSummary = sessions.find((s) => s.id === selectedSessionId);
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
    useAttemptExecution(workspaceId, task.id);

  const { data: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus(workspaceId);
  const { repos } = useAttemptRepo(workspaceId);

  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) => r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );
  const { branch: attemptBranch, refetch: refetchAttemptBranch } =
    useAttemptBranch(workspaceId);
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
  const { fileCount, added, deleted } = useDiffSummary(workspaceId ?? null);

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

  const {
    scratch,
    updateScratch,
    deleteScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.DRAFT_FOLLOW_UP, scratchId ?? '');

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
          };
        })
      | undefined;

    const raw = data?.executor_config ?? data?.executor_profile_id;
    if (!raw?.executor) return null;

    return {
      executor: raw.executor,
      variant: raw.variant ?? null,
    } satisfies ExecutorProfileId;
  }, [scratchData]);

  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const [localMessage, setLocalMessage] = useState('');
  const [newSessionName, setNewSessionName] = useState('');
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);

  const latestProfileId = useMemo(
    () => getLatestProfileFromProcesses(processes),
    [processes]
  );

  const defaultExecutorProfile = useMemo(() => {
    if (scratchExecutorProfile) return scratchExecutorProfile;
    if (latestProfileId) return latestProfileId;
    if (session?.executor) {
      return { executor: session.executor as BaseCodingAgent, variant: null };
    }
    if (config?.executor_profile) return config.executor_profile;
    return getFirstAvailableProfile(profiles);
  }, [
    scratchExecutorProfile,
    latestProfileId,
    session?.executor,
    config?.executor_profile,
    profiles,
  ]);

  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const previousScratchIdRef = useRef<string | undefined>(scratchId);

  useEffect(() => {
    const scratchChanged = previousScratchIdRef.current !== scratchId;
    previousScratchIdRef.current = scratchId;
    if (scratchChanged || !selectedExecutorProfile) {
      setSelectedExecutorProfile(defaultExecutorProfile);
    }
  }, [defaultExecutorProfile, selectedExecutorProfile, scratchId]);

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
      if (!message.trim() && !executorProfileId.variant && !scratchRef.current)
        return;
      try {
        await updateScratch({
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: { message, executor_profile_id: executorProfileId },
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
      ? `${effectiveExecutorProfile.executor}:${effectiveExecutorProfile.variant ?? 'DEFAULT'}`
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
    if (hydratedScratchIdRef.current === scratchId) return;
    hydratedScratchIdRef.current = scratchId;
    setLocalMessage(scratchData?.message ?? '');
  }, [isScratchLoading, scratchData?.message, scratchId]);

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
      sessionId ? queueApi.getStatus(sessionId) : Promise.resolve(EMPTY_QUEUE_STATUS),
    enabled: !!sessionId,
  });

  const isQueued = queueStatus.status === 'queued';
  const queuedMessage = isQueued
    ? (queueStatus as Extract<QueueStatus, { status: 'queued' }>).message
    : null;

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
      setLocalMessage(scratchData?.message ?? '');
    }
  }, [
    isAttemptRunning,
    workspaceId,
    processes.length,
    refreshQueueStatus,
    scratchData?.message,
  ]);

  const displayMessage =
    isQueued && queuedMessage ? queuedMessage.data.message : localMessage;

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

  const { entries } = useEntries();
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
      workspaceId,
      isNewSessionMode,
      newSessionName,
      onSelectSession: handleSelectSession,
      onSessionCreated,
      message: localMessage,
      conflictMarkdown: conflictResolutionInstructions,
      reviewMarkdown,
      executorProfileId: effectiveExecutorProfile,
      clearComments,
      onAfterSendCleanup: async () => {
        cancelDebouncedSave();
        setLocalMessage('');
        setNewSessionName('');
        hydratedScratchIdRef.current = scratchId;
        if (scratchId) {
          await deleteScratch();
        }
      },
    });

  const canTypeFollowUp = useMemo(() => {
    if (!workspaceId || isSendingFollowUp) return false;
    if (isRetryActive) return false;
    if (hasPendingApproval) return false;
    return true;
  }, [workspaceId, isSendingFollowUp, isRetryActive, hasPendingApproval]);

  const canSendFollowUp = useMemo(() => {
    if (!canTypeFollowUp || !effectiveExecutorProfile?.executor) return false;
    if (isAwaitingNewSessionConfirmation) return false;
    return Boolean(
      conflictResolutionInstructions || reviewMarkdown || localMessage.trim()
    );
  }, [
    canTypeFollowUp,
    isAwaitingNewSessionConfirmation,
    effectiveExecutorProfile?.executor,
    conflictResolutionInstructions,
    reviewMarkdown,
    localMessage,
  ]);
  const canEnhancePrompt = useMemo(
    () =>
      Boolean(
        canTypeFollowUp &&
          localMessage.trim()
      ),
    [canTypeFollowUp, localMessage]
  );
  const isEditable = !isRetryActive && !hasPendingApproval;

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
          const imageMarkdown = `![${response.original_name}](${response.file_path})`;
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

  const handleReviewChanges = useCallback(async () => {
    if (!sessionId || !effectiveExecutorProfile) return;
    try {
      await sessionsApi.startReview(sessionId, {
        executor_profile_id: effectiveExecutorProfile,
        additional_prompt: reviewMarkdown.trim() || null,
        use_all_workspace_commits: true,
      });
      if (reviewMarkdown.trim()) {
        clearComments();
      }
    } catch (error) {
      console.error('Failed to start review:', error);
    }
  }, [sessionId, effectiveExecutorProfile, reviewMarkdown, clearComments]);

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
      const message = getErrorMessage(error);
      setFollowUpError(`Failed to enhance prompt: ${message}`);
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

  const handleConfirmNewSession = useCallback(() => {
    confirmNewSession();
  }, [confirmNewSession]);

  const handleCancelNewSession = useCallback(() => {
    cancelNewSession();
    setNewSessionName('');
    setSelectedExecutorProfile(defaultExecutorProfile);
  }, [cancelNewSession, defaultExecutorProfile]);

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
          'flex flex-col min-h-0 overflow-hidden',
          isRetryActive && 'opacity-50'
        )}
      >
        {/* Scrollable content area */}
        <div className="overflow-y-auto min-h-0 px-3">
          <div className="space-y-2">
            {followUpError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{followUpError}</AlertDescription>
              </Alert>
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

              <MessageQueueIndicator isQueued={isQueued && !!queuedMessage} />
            </div>
          </div>
        </div>

        {/* Input area with buttons inside */}
        <div
          className="flex flex-col gap-1 shrink-0 rounded-lg border border-border bg-background mx-3 mb-3 p-2 overflow-hidden"
          onFocus={() => setIsTextareaFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setIsTextareaFocused(false);
            }
          }}
        >
          {/* Top bar */}
          {(tokenUsageInfo ||
            (showSessionSelector && sessions.length > 0) ||
            effectiveExecutorProfile?.executor) && (
            <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
              <DiffStatsBar
                executorProfile={effectiveExecutorProfile}
                sessionExecutor={session?.executor}
              />
              {fileCount > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px]">
                      {`${fileCount} 个文件更改`}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{`+${added} -${deleted}`}</TooltipContent>
                </Tooltip>
              ) : null}

              <div className="flex-1" />

              <TokenUsageIndicator tokenUsageInfo={tokenUsageInfo} />

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onJumpToPreviousUserMessage}
                    className="flex items-center justify-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={'\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f'}
                    disabled={!onJumpToPreviousUserMessage}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{'\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f'}</TooltipContent>
              </Tooltip>

              {showSessionSelector ? (
                <SessionSelector
                  sessions={sessions}
                  selectedSessionId={selectedSessionId}
                  compactSessionLabel={compactSessionLabel}
                  selectedSessionLabel={selectedSessionLabel}
                  onSelectSession={handleSelectSession}
                  onStartNewSession={requestNewSession}
                  onRenameSession={handleRenameSession}
                />
              ) : null}
            </div>
          )}

          {isNewSessionConfigVisible ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-foreground">
                  {'\u65b0\u5efa\u4f1a\u8bdd\u914d\u7f6e'}
                </div>
                {isAwaitingNewSessionConfirmation ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleCancelNewSession}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="取消新建会话"
                      title="取消新建会话"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmNewSession}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="确认新建会话"
                      title="确认新建会话"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mb-2 space-y-1">
                <div className="text-[11px] text-muted-foreground">
                  {'\u4f1a\u8bdd\u540d\u79f0\uff08\u53ef\u9009\uff09'}
                </div>
                <Input
                  value={newSessionName}
                  onChange={(event) => setNewSessionName(event.target.value)}
                  placeholder={'\u4e0d\u586b\u5219\u4f7f\u7528\u9996\u6761\u6d88\u606f\u81ea\u52a8\u547d\u540d'}
                  className="h-8 rounded-md border-border/60 bg-background text-sm"
                  autoFocus
                />
              </div>
              <TerminalProfileControls
                profiles={profiles}
                selectedProfile={effectiveExecutorProfile}
                onChange={(profile) => setSelectedExecutorProfile(profile)}
                disabled={!isEditable}
                showLabel={true}
                iconOnly={false}
                className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_auto]"
              />
            </div>
          ) : null}


          <WYSIWYGEditor
            placeholder=""
            value={displayMessage}
            onChange={handleEditorChange}
            disabled={!isEditable}
            onPasteFiles={handlePasteFiles}
            repoIds={repos.map((r) => r.id)}
            projectId={projectId}
            executorProfile={effectiveExecutorProfile}
            taskAttemptId={workspaceId}
            onCmdEnter={handleSubmitShortcut}
            sendShortcut={config?.send_message_shortcut}
            className="min-h-[40px] break-words overflow-wrap-anywhere"
            onRegisterClickedElementInsert={handleRegisterClickedElementInsert}
            enableFloatingToolbar={false}
          />

          <ActionBar
            profiles={profiles}
            effectiveExecutorProfile={effectiveExecutorProfile}
            onChangeExecutorProfile={setSelectedExecutorProfile}
            showProfileControls={!isNewSessionConfigVisible}
            isEditable={isEditable}
            isAttemptRunning={isAttemptRunning}
            isQueued={isQueued}
            isQueueLoading={isQueueLoading}
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
            onQueueMessage={handleQueueMessage}
            onCancelQueue={cancelQueue}
            onStopExecution={stopExecution}
            onSendFollowUp={onSendFollowUp}
            onEnhancePrompt={handleEnhancePrompt}
            onClearComments={clearComments}
            onReviewChanges={handleReviewChanges}
            onPasteFiles={handlePasteFiles}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
