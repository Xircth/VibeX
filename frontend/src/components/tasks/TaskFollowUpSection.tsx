import {
  Loader2,
  Send,
  StopCircle,
  AlertCircle,
  Clock,
  X,
  Paperclip,
  CheckSquare,
  FileSearch,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
//
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ScratchType, type TaskWithAttemptStatus } from 'shared/types';
import { useBranchStatus } from '@/hooks';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { cn } from '@/lib/utils';
//
import { useReview } from '@/contexts/ReviewProvider';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { useEntries } from '@/contexts/EntriesContext';
import { useTodos } from '@/hooks/useTodos';
import { useKeySubmitFollowUp, Scope } from '@/keyboard';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useProject } from '@/contexts/ProjectContext';
//
import { AgentIcon } from '@/components/agents/AgentIcon';
import { useUserSystem } from '@/components/ConfigProvider';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { FollowUpConflictSection } from '@/components/tasks/follow-up/FollowUpConflictSection';
import { ClickedElementsBanner } from '@/components/tasks/ClickedElementsBanner';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';

import type {
  BaseCodingAgent,
  DraftFollowUpData,
  ExecutorProfileId,
  QueueStatus,
} from 'shared/types';
import {
  getFirstAvailableProfile,
  getLatestProfileFromProcesses,
} from '@/utils/executor';
import { buildResolveConflictsInstructions } from '@/lib/conflicts';
import { useScratch } from '@/hooks/useScratch';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queueApi, imagesApi, sessionsApi } from '@/lib/api';
import type { Session } from 'shared/types';
import { buildAgentPrompt } from '@/utils/promptMessage';
import { useTokenUsage } from '@/contexts/EntriesContext';
import { useDiffSummary } from '@/hooks/useDiffSummary';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowUp } from 'lucide-react';

interface TaskFollowUpSectionProps {
  task: TaskWithAttemptStatus;
  session?: Session;
  workspaceId?: string;
  onJumpToPreviousUserMessage?: () => void;
  sessionState: Pick<
    UseWorkspaceSessionsResult,
    | 'sessions'
    | 'selectedSessionId'
    | 'selectSession'
    | 'startNewSession'
    | 'isNewSessionMode'
  >;
}

function truncateSessionLabel(label: string, maxUnits = 8): string {
  if (!label) return 'session';

  let units = 0;
  let compact = '';

  for (const char of label) {
    const nextUnits = /[^\x00-\xff]/.test(char) ? 2 : 1;
    if (units + nextUnits > maxUnits) {
      break;
    }
    compact += char;
    units += nextUnits;
  }

  return compact || label;
}

export function TaskFollowUpSection({
  task,
  session,
  workspaceId: workspaceIdProp,
  onJumpToPreviousUserMessage,
  sessionState,
}: TaskFollowUpSectionProps) {
  const { projectId } = useProject();

  // Derive IDs from session
  const workspaceId = session?.workspace_id ?? workspaceIdProp;
  const {
    sessions,
    selectedSessionId,
    selectSession,
    startNewSession,
    isNewSessionMode,
  } = sessionState;
  const sessionId = isNewSessionMode ? undefined : session?.id;
  const { profiles, config } = useUserSystem();
  const selectedSessionLabel = isNewSessionMode
    ? `session${sessions.length + 1}`
    : sessions.find((currentSession) => currentSession.id === selectedSessionId)
        ?.displayName ?? 'session';
  const compactSessionLabel = truncateSessionLabel(selectedSessionLabel);

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
  const {
    generateMarkdown: generateClickedMarkdown,
    clearElements: clearClickedElements,
  } = useClickedElements();
  const { enableScope, disableScope } = useHotkeysContext();

  // Issue 1: Diff summary stats
  const diffSummary = useDiffSummary(workspaceId ?? null);

  // Issue 2: Token usage
  const tokenUsageInfo = useTokenUsage();

  const reviewMarkdown = useMemo(
    () => generateReviewMarkdown(),
    [generateReviewMarkdown]
  );

  const clickedMarkdown = useMemo(
    () => generateClickedMarkdown(),
    [generateClickedMarkdown]
  );

  // Non-editable conflict resolution instructions (derived, like review comments)
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

  // Editor state (persisted via scratch)
  const {
    scratch,
    updateScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.DRAFT_FOLLOW_UP, scratchId ?? '');

  // Derive the message and variant from scratch
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

  // Track whether the follow-up textarea is focused
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);

  // Local message state for immediate UI feedback (before debounced save)
  const [localMessage, setLocalMessage] = useState('');

  // Variant selection - derive default from latest process
  const latestProfileId = useMemo(
    () => getLatestProfileFromProcesses(processes),
    [processes]
  );

  const defaultExecutorProfile = useMemo(() => {
    if (scratchExecutorProfile) {
      return scratchExecutorProfile;
    }

    if (latestProfileId) {
      return latestProfileId;
    }

    if (session?.executor) {
      return {
        executor: session.executor as BaseCodingAgent,
        variant: null,
      };
    }

    if (config?.executor_profile) {
      return config.executor_profile;
    }

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
  const lastAutoInsertedClickedMarkdownRef = useRef('');

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

  // Refs to stabilize callbacks - avoid re-creating callbacks when these values change
  const scratchRef = useRef(scratch);
  useEffect(() => {
    scratchRef.current = scratch;
  }, [scratch]);

  // Save scratch helper (used for both message and variant changes)
  // Uses scratchRef to avoid callback invalidation when scratch updates
  const saveToScratch = useCallback(
    async (message: string, executorProfileId: ExecutorProfileId | null) => {
      if (!workspaceId || !executorProfileId?.executor) return;
      // Don't create empty scratch entries - only save if there's actual content,
      // a variant is selected, or scratch already exists (to allow clearing a draft)
      if (!message.trim() && !executorProfileId.variant && !scratchRef.current)
        return;
      try {
        await updateScratch({
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: {
              message,
              executor_profile_id: executorProfileId,
            },
          },
        });
      } catch (e) {
        console.error('Failed to save follow-up draft', e);
      }
    },
    [workspaceId, updateScratch]
  );

  // Debounced save for message changes (uses current executor profile from ref)
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

    if (previousExecutorProfileKeyRef.current === profileKey) {
      return;
    }

    previousExecutorProfileKeyRef.current = profileKey;

    if (!isScratchLoading) {
      void saveToScratch(localMessage, effectiveExecutorProfile);
    }
  }, [effectiveExecutorProfile, isScratchLoading, localMessage, saveToScratch]);

  // Sync local message from scratch when it loads (but not while user is typing)
  useEffect(() => {
    if (isScratchLoading) return;
    if (isTextareaFocused) return; // Don't overwrite while user is typing
    setLocalMessage(scratchData?.message ?? '');
  }, [isScratchLoading, scratchData?.message, isTextareaFocused]);

  // During retry, follow-up box is greyed/disabled (not hidden)
  // Use RetryUi context so optimistic retry immediately disables this box
  const { activeRetryProcessId } = useRetryUi();
  const isRetryActive = !!activeRetryProcessId;

  // Queue status for queuing follow-up messages while agent is running
  const queryClient = useQueryClient();
  const QUEUE_STATUS_KEY = 'queue-status';

  const {
    data: queueStatus = { status: 'empty' as const },
    refetch: refreshQueueStatus,
  } = useQuery<QueueStatus>({
    queryKey: [QUEUE_STATUS_KEY, sessionId],
    queryFn: () => queueApi.getStatus(sessionId!),
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

  // Track previous process count to detect new processes
  const prevProcessCountRef = useRef(processes.length);

  // Refresh queue status when execution stops OR when a new process starts
  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    if (!workspaceId) return;

    // Refresh when execution stops
    if (!isAttemptRunning) {
      refreshQueueStatus();
      return;
    }

    // Refresh when a new process starts (could be queued message consumption or follow-up)
    if (processes.length > prevCount) {
      refreshQueueStatus();
      // Re-sync local message from current scratch state
      // If scratch was deleted, scratchData will be undefined, so localMessage becomes ''
      setLocalMessage(scratchData?.message ?? '');
    }
  }, [
    isAttemptRunning,
    workspaceId,
    processes.length,
    refreshQueueStatus,
    scratchData?.message,
  ]);

  // When queued, display the queued message content so user can edit it
  const displayMessage =
    isQueued && queuedMessage ? queuedMessage.data.message : localMessage;

  // Check if there's a pending approval - users shouldn't be able to type during approvals
  const { entries } = useEntries();
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

  // Send follow-up action
  const { isSendingFollowUp, followUpError, setFollowUpError, onSendFollowUp } =
    useFollowUpSend({
      sessionId,
      workspaceId,
      isNewSessionMode,
      onSelectSession: selectSession,
      message: localMessage,
      conflictMarkdown: conflictResolutionInstructions,
      reviewMarkdown,
      clickedMarkdown,
      executorProfileId: effectiveExecutorProfile,
      clearComments,
      clearClickedElements,
      onAfterSendCleanup: () => {
        cancelDebouncedSave(); // Cancel any pending debounced save to avoid race condition
        setLocalMessage(''); // Clear local state immediately
        // Scratch deletion is handled by the backend when the queued message is consumed
      },
    });

  // Separate logic for when textarea should be disabled vs when send button should be disabled
  const canTypeFollowUp = useMemo(() => {
    if (!workspaceId || isSendingFollowUp) {
      return false;
    }

    if (isRetryActive) return false; // disable typing while retry editor is active
    if (hasPendingApproval) return false; // disable typing during approval
    // Note: isQueued no longer blocks typing - editing auto-cancels the queue
    return true;
  }, [workspaceId, isSendingFollowUp, isRetryActive, hasPendingApproval]);

  const canSendFollowUp = useMemo(() => {
    if (!canTypeFollowUp || !effectiveExecutorProfile?.executor) {
      return false;
    }

    // Allow sending if conflict instructions, review comments, clicked elements, or message is present
    return Boolean(
      conflictResolutionInstructions ||
      reviewMarkdown ||
      clickedMarkdown ||
      localMessage.trim()
    );
  }, [
    canTypeFollowUp,
    effectiveExecutorProfile?.executor,
    conflictResolutionInstructions,
    reviewMarkdown,
    clickedMarkdown,
    localMessage,
  ]);
  const isEditable = !isRetryActive && !hasPendingApproval;

  // Handler to queue the current message for execution after agent finishes
  const handleQueueMessage = useCallback(async () => {
    if (
      !localMessage.trim() &&
      !conflictResolutionInstructions &&
      !reviewMarkdown &&
      !clickedMarkdown
    ) {
      return;
    }

    // Cancel any pending debounced save and save immediately before queueing
    // This prevents the race condition where the debounce fires after queueing
    cancelDebouncedSave();
    await saveToScratch(localMessage, effectiveExecutorProfile);

    // Combine all the content that would be sent (same as follow-up send)
    const { prompt } = buildAgentPrompt(
      localMessage,
      [conflictResolutionInstructions, clickedMarkdown, reviewMarkdown].filter(
        Boolean
      )
    );
    if (effectiveExecutorProfile) {
      await queueMessage(prompt, effectiveExecutorProfile);
    }
  }, [
    localMessage,
    conflictResolutionInstructions,
    reviewMarkdown,
    clickedMarkdown,
    effectiveExecutorProfile,
    queueMessage,
    cancelDebouncedSave,
    saveToScratch,
  ]);

  // Keyboard shortcut handler - send follow-up or queue depending on state
  const handleSubmitShortcut = useCallback(
    (e?: KeyboardEvent) => {
      e?.preventDefault();
      if (isAttemptRunning) {
        // When running, CMD+Enter queues the message (if not already queued)
        if (!isQueued) {
          handleQueueMessage();
        }
      } else {
        onSendFollowUp();
      }
    },
    [isAttemptRunning, isQueued, handleQueueMessage, onSendFollowUp]
  );

  // Ref to access setFollowUpMessage without adding it as a dependency
  const setFollowUpMessageRef = useRef(setFollowUpMessage);
  useEffect(() => {
    setFollowUpMessageRef.current = setFollowUpMessage;
  }, [setFollowUpMessage]);

  // Ref for followUpError to use in stable onChange handler
  const followUpErrorRef = useRef(followUpError);
  useEffect(() => {
    followUpErrorRef.current = followUpError;
  }, [followUpError]);

  // Helper to get current queue state from cache (avoids ref-sync pattern)
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

  // Handle image paste - upload to container and insert markdown
  const handlePasteFiles = useCallback(
    async (files: File[]) => {
      if (!workspaceId) return;

      for (const file of files) {
        try {
          const response = await imagesApi.uploadForAttempt(workspaceId, file);
          // Append markdown image to current message
          const imageMarkdown = `![${response.original_name}](${response.file_path})`;

          // If queued, cancel queue and use queued message as base (same as editor change behavior)
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
              setFollowUpMessageRef.current(newMessage); // Debounced save to scratch
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

  useEffect(() => {
    if (!clickedMarkdown) {
      lastAutoInsertedClickedMarkdownRef.current = '';
      return;
    }

    if (lastAutoInsertedClickedMarkdownRef.current === clickedMarkdown) {
      return;
    }

    lastAutoInsertedClickedMarkdownRef.current = clickedMarkdown;

    const appendClickedMarkdown = (base: string) =>
      base ? `${base}\n\n${clickedMarkdown}` : clickedMarkdown;

    const {
      isQueued: currentlyQueued,
      queuedMessage: currentQueuedMessage,
    } = getQueueState();

    if (currentlyQueued && currentQueuedMessage) {
      cancelMutation.mutate();
      const newMessage = appendClickedMarkdown(currentQueuedMessage.data.message);
      setLocalMessage(newMessage);
      setFollowUpMessageRef.current(newMessage);
    } else {
      setLocalMessage((prev) => {
        const newMessage = appendClickedMarkdown(prev);
        setFollowUpMessageRef.current(newMessage);
        return newMessage;
      });
    }

    if (followUpErrorRef.current) {
      setFollowUpError(null);
    }

    clearClickedElements();
  }, [
    clickedMarkdown,
    getQueueState,
    cancelMutation,
    setFollowUpError,
    clearClickedElements,
  ]);

  // Attachment button - file input ref and handlers
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((f) =>
        f.type.startsWith('image/')
      );
      if (files.length > 0) {
        handlePasteFiles(files);
      }
      // Reset input so same file can be selected again
      e.target.value = '';
    },
    [handlePasteFiles]
  );

  // Handler for review changes
  const handleReviewChanges = useCallback(async () => {
    if (!sessionId || !effectiveExecutorProfile) return;
    try {
      await sessionsApi.startReview(sessionId, {
        executor_profile_id: effectiveExecutorProfile,
        additional_prompt: null,
        use_all_workspace_commits: true,
      });
    } catch (error) {
      console.error('Failed to start review:', error);
    }
  }, [sessionId, effectiveExecutorProfile]);

  // Stable onChange handler for WYSIWYGEditor
  const handleEditorChange = useCallback(
    (value: string) => {
      // Auto-cancel queue when user starts editing
      const { isQueued: currentlyQueued } = getQueueState();
      if (currentlyQueued) {
        cancelMutation.mutate();
      }
      setLocalMessage(value); // Immediate update for UI responsiveness
      setFollowUpMessageRef.current(value); // Debounced save to scratch
      if (followUpErrorRef.current) setFollowUpError(null);
    },
    [setFollowUpError, getQueueState, cancelMutation]
  );

  const editorPlaceholder = '';

  // Register keyboard shortcuts
  useKeySubmitFollowUp(handleSubmitShortcut, {
    scope: Scope.FOLLOW_UP_READY,
    enableOnFormTags: ['textarea', 'TEXTAREA'],
    when: canSendFollowUp && isEditable,
  });

  // Enable FOLLOW_UP scope when textarea is focused AND editable
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

  // Enable FOLLOW_UP_READY scope when ready to send
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

  // When a process completes (e.g., agent resolved conflicts), refresh branch status promptly
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
        {/* Scrollable content area — only takes space when it has visible content */}
        <div className="overflow-y-auto min-h-0 px-3">
          <div className="space-y-2">
            {followUpError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{followUpError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              {/* Review comments preview */}
              {reviewMarkdown && (
                <div className="mb-4">
                  <div className="text-sm whitespace-pre-wrap break-words rounded-md border bg-muted p-3">
                    {reviewMarkdown}
                  </div>
                </div>
              )}

              {/* Conflict notice and actions (optional UI) */}
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

              {/* Clicked elements notice and actions */}
              <ClickedElementsBanner />

              {/* Queued message indicator */}
              {isQueued && queuedMessage && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-md border">
                  <Clock className="h-4 w-4 flex-shrink-0" />
                  <div className="font-medium">
                    {'消息已排队 - 将在当前运行完成时执行'}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Input area with buttons inside */}
        <div
          className="flex flex-col gap-1 shrink-0 rounded-lg border border-border bg-background mx-3 mb-3 p-2 overflow-hidden"
          onFocus={() => setIsTextareaFocused(true)}
          onBlur={(e) => {
            // Only blur if focus is leaving the container entirely
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setIsTextareaFocused(false);
            }
          }}
        >
          {/* Top bar - diff stats, token usage, agent icon, jump button, session selector */}
          {(diffSummary.fileCount > 0 ||
            tokenUsageInfo ||
            sessions.length > 0 ||
            effectiveExecutorProfile?.executor) && (
            <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
              {effectiveExecutorProfile?.executor && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center justify-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5">
                      <AgentIcon
                        agent={effectiveExecutorProfile.executor}
                        className="h-3.5 w-3.5"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    当前终端：
                    {session?.executor ?? effectiveExecutorProfile.executor}
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Issue 1: File change stats */}
              {diffSummary.fileCount > 0 && (
                <>
                  <span>{diffSummary.fileCount} 个文件已更改</span>
                  <span className="text-green-600">+{diffSummary.added}</span>
                  <span className="text-red-600">-{diffSummary.deleted}</span>
                </>
              )}

              <div className="flex-1" />

              {/* Issue 2: Token usage */}
              {tokenUsageInfo && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default tabular-nums rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5">
                      {Math.round(
                        (tokenUsageInfo.total_tokens /
                          tokenUsageInfo.model_context_window) *
                          100
                      )}
                      %
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    实际占用：{Math.round(tokenUsageInfo.total_tokens / 1000)}k
                    / {Math.round(tokenUsageInfo.model_context_window / 1000)}k
                    tokens
                  </TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onJumpToPreviousUserMessage}
                    className="flex items-center justify-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="回到上一条用户消息"
                    disabled={!onJumpToPreviousUserMessage}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>回到上一条用户消息</TooltipContent>
              </Tooltip>

              {/* Issue 3: Session selector */}
              {sessions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                      title={selectedSessionLabel}
                    >
                      <Badge
                        variant="outline"
                        className="max-w-[96px] rounded-md border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                      >
                        <span className="truncate">{compactSessionLabel}</span>
                      </Badge>
                      <ChevronDown className="h-2.5 w-2.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {sessions.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => selectSession(s.id)}
                        className={
                          selectedSessionId === s.id ? 'bg-accent' : ''
                        }
                      >
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="truncate max-w-[180px]">{s.displayName}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {s.statusLabel}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={startNewSession}>
                      {`+ 新建 session${sessions.length + 1}`}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}

          <WYSIWYGEditor
            placeholder={editorPlaceholder}
            value={displayMessage}
            onChange={handleEditorChange}
            disabled={!isEditable}
            onPasteFiles={handlePasteFiles}
            repoIds={repos.map((r) => r.id)}
            projectId={projectId}
            executor={effectiveExecutorProfile?.executor ?? null}
            taskAttemptId={workspaceId}
            onCmdEnter={handleSubmitShortcut}
            sendShortcut={config?.send_message_shortcut}
            className="min-h-[40px] break-words overflow-wrap-anywhere"
          />

          {/* Action buttons inside the input container */}
          <div className="flex flex-wrap gap-1 items-center pt-1 border-t border-border/50">
            <TerminalProfileControls
              profiles={profiles}
              selectedProfile={effectiveExecutorProfile}
              onChange={setSelectedExecutorProfile}
              disabled={!isEditable}
              lockExecutor={true}
              className="flex flex-wrap gap-1 items-center"
            />

            {/* Hidden file input for attachment - always present */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />

            {/* Attach button */}
            <Button
              onClick={handleAttachClick}
              disabled={!isEditable}
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              title="Attach image"
              aria-label="Attach image"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>

            {/* Review Changes button */}
            <Button
              onClick={handleReviewChanges}
              disabled={!isEditable || !sessionId}
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              title="Review Changes"
              aria-label="Review Changes"
            >
              <FileSearch className="h-3.5 w-3.5" />
            </Button>

            {/* TodoList preview popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  title="查看待办事项"
                  className={cn(
                    'h-7 w-7 p-0',
                    todos.length === 0 && 'opacity-50'
                  )}
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  {todos.length > 0 && (
                    <span className="ml-0.5 text-[10px]">{todos.length}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                {todos.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-2 text-center">
                    暂无待办事项
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-medium mb-1.5">
                      待办事项 ({todos.length})
                    </div>
                    <ul className="space-y-1 max-h-48 overflow-auto">
                      {todos.map((todo, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-1.5 text-xs"
                        >
                          <span
                            className={`shrink-0 mt-0.5 ${
                              todo.status === 'completed'
                                ? 'text-green-500'
                                : todo.status === 'in_progress' ||
                                    todo.status === 'in-progress'
                                  ? 'text-blue-500'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            {todo.status === 'completed'
                              ? '✓'
                              : todo.status === 'in_progress' ||
                                  todo.status === 'in-progress'
                                ? '●'
                                : '○'}
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

            {/* Spacer to push send/stop buttons to right */}
            <div className="flex-1" />

            {/* Send/Stop/Queue buttons */}
            {isAttemptRunning ? (
              <div className="flex items-center gap-1">
                {/* Queue/Cancel Queue button when running */}
                {isQueued ? (
                  <Button
                    onClick={cancelQueue}
                    disabled={isQueueLoading || !sessionId}
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                  >
                    {isQueueLoading ? (
                      <Loader2 className="animate-spin h-3.5 w-3.5" />
                    ) : (
                      <>
                        <X className="h-3.5 w-3.5 mr-1" />
                        {'取消队列'}
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={handleQueueMessage}
                    disabled={
                      isQueueLoading ||
                      !sessionId ||
                      (!localMessage.trim() &&
                        !conflictResolutionInstructions &&
                        !reviewMarkdown &&
                        !clickedMarkdown)
                    }
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                  >
                    {isQueueLoading ? (
                      <Loader2 className="animate-spin h-3.5 w-3.5" />
                    ) : (
                      <>
                        <Clock className="h-3.5 w-3.5 mr-1" />
                        {'队列'}
                      </>
                    )}
                  </Button>
                )}
                <Button
                  onClick={stopExecution}
                  disabled={isStopping}
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-xs"
                >
                  {isStopping ? (
                    <Loader2 className="animate-spin h-3.5 w-3.5" />
                  ) : (
                    <>
                      <StopCircle className="h-3.5 w-3.5 mr-1" />
                      {'停止'}
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {comments.length > 0 && (
                  <Button
                    onClick={clearComments}
                    size="sm"
                    variant="destructive"
                    disabled={!isEditable}
                    className="h-7 px-2 text-xs"
                  >
                    {'清除审查'}
                  </Button>
                )}
                <Button
                  onClick={onSendFollowUp}
                  disabled={!canSendFollowUp || !isEditable}
                  size="sm"
                  className="h-7 px-2 text-xs rounded-lg"
                >
                  {isSendingFollowUp ? (
                    <Loader2 className="animate-spin h-3.5 w-3.5" />
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5 mr-1" />
                      {conflictResolutionInstructions ? '解决冲突' : '发送'}
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
