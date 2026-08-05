import { Loader2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentKind } from 'shared/types';
import { useBranchStatus } from '@/hooks';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { cn } from '@/lib/utils';
import { useReview } from '@/contexts/ReviewProvider';
import { useEntries } from '@/contexts/EntriesContext';
import { useConversationStatus } from '@/contexts/ConversationStatusContext';
import { useTodos } from '@/hooks/useTodos';
import { useKeySubmitFollowUp, Scope } from '@/keyboard';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useUserSystem } from '@/components/ConfigProvider';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { FollowUpConflictSection } from '@/components/tasks/follow-up/FollowUpConflictSection';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useActiveExecutorProfile } from '@/contexts/ActiveExecutorProfileContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';
import { conversationApi } from '@/features/conversation/conversationApi';
import { useGitStatus } from '@/hooks/git';

import type { Session } from 'shared/types';
import { getLatestProfileFromProcesses } from '@/utils/executor';
import { buildPromptEnhancementContext } from '@/lib/promptEnhancement';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useParams } from 'react-router-dom';

import { SessionComposerTopbar } from './follow-up/SessionComposerTopbar';
import { ReviewCommentsPreview } from './follow-up/ReviewCommentsPreview';
import { MessageQueueIndicator } from './follow-up/MessageQueueIndicator';
import { ActionBar } from './follow-up/ActionBar';
import { ConversationStatusDock } from './follow-up/ConversationStatusDock';
import {
  areConfigValuesEqual,
  sanitizeDependentConfigValues,
  visibleSessionConfigOptions,
  selectConfigOptionValue,
} from './follow-up/SessionConfigOptionSelectors';
import { SessionComposerInput } from './follow-up/SessionComposerInput';
import { AgentMentionProvider } from './follow-up/AgentMention';
import { getDefaultExecutorProfile } from './follow-up/sessionComposerDraft';
import {
  clearComposerImageAttachments,
  imageAttachmentFromPath,
  revokeComposerImagePreviewUrl,
} from './follow-up/sessionComposerImages';
import {
  getChangedFileCount,
  getSummaryRepoId,
  shouldShowChangedFileSummary,
} from './follow-up/sessionComposerGitSummary';
import {
  buildComposerConflictInstructions,
  getConflictActionState,
  getComposerRepoWithConflicts,
} from './follow-up/sessionComposerConflicts';
import {
  getComposerSessionId,
  getComposerSessionLabels,
  getComposerScratchTargetId,
  getComposerTopbarVisibility,
  getComposerWorkspaceId,
} from './follow-up/sessionComposerSession';
import {
  canEditFollowUp as getCanEditFollowUp,
  canSendFollowUp as getCanSendFollowUp,
  canTypeFollowUp as getCanTypeFollowUp,
  hasPendingToolApproval,
  isComposerExecutionActive,
} from './follow-up/sessionComposerSubmit';
import { canEnhancePrompt as getCanEnhancePrompt } from './follow-up/sessionComposerPromptEnhancement';
import { useSessionComposerPromptEnhancement } from './follow-up/useSessionComposerPromptEnhancement';
import { useSessionComposerContextCompact } from './follow-up/useSessionComposerContextCompact';
import { useSessionComposerQueue } from './follow-up/useSessionComposerQueue';
import { useSessionComposerImageUpload } from './follow-up/useSessionComposerImageUpload';
import { useSessionComposerSessionRename } from './follow-up/useSessionComposerSessionRename';
import { useSessionComposerSessionCallbacks } from './follow-up/useSessionComposerSessionCallbacks';
import { useSessionComposerAttemptRefresh } from './follow-up/useSessionComposerAttemptRefresh';
import { useSessionComposerDraftScratch } from './follow-up/useSessionComposerDraftScratch';
import { useSessionComposerExecutorProfileHydration } from './follow-up/useSessionComposerExecutorProfileHydration';
import { useSessionComposerDraftHydration } from './follow-up/useSessionComposerDraftHydration';
import { useSessionComposerHotkeys } from './follow-up/useSessionComposerHotkeys';
import { useSessionComposerEditorChange } from './follow-up/useSessionComposerEditorChange';
import { useSessionComposerPreviewElementInsertion } from './follow-up/useSessionComposerPreviewElementInsertion';
import { useSessionComposerSubmitActions } from './follow-up/useSessionComposerSubmitActions';
import { useSessionComposerImageRemoval } from './follow-up/useSessionComposerImageRemoval';
import { useSessionComposerFocus } from './follow-up/useSessionComposerFocus';
import type { QueuedMessage } from './follow-up/sessionComposerQueue';
import {
  useSessionComposerLocalState,
  useSessionComposerProfileSelection,
} from './follow-up/useSessionComposerLocalState';
import {
  codexGoalEntriesFromConversation,
  deriveCodexGoalState,
} from '@/lib/codexGoalState';
import { configuredBackendTransport } from '@/lib/backendTransport';

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
  onCreateSessionRequested?: () => void;
  sessionState: Pick<
    UseWorkspaceSessionsResult,
    'sessions' | 'selectedSessionId' | 'selectSession' | 'isNewSessionMode'
  >;
}

export function TaskFollowUpSection({
  taskId,
  session,
  workspaceId: workspaceIdProp,
  onJumpToPreviousUserMessage,
  showSessionSelector = true,
  onSessionCreated,
  onSessionSelected,
  onCreateSessionRequested,
  sessionState,
}: TaskFollowUpSectionProps) {
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const workspaceId = getComposerWorkspaceId({
    activeWorktreeId,
    routeWorkspaceId,
    workspaceIdProp,
    sessionWorkspaceId: session?.workspace_id,
  });
  const workspaceIdValue = workspaceId ?? undefined;
  const { sessions, selectedSessionId, selectSession, isNewSessionMode } =
    sessionState;
  const isAwaitingNewSessionConfirmation = false;
  const sessionId = getComposerSessionId({
    isNewSessionMode,
    sessionId: session?.id,
  });
  const { profiles, config } = useUserSystem();
  const { selectedSessionLabel, compactSessionLabel } =
    getComposerSessionLabels({
      sessions,
      selectedSessionId,
      isNewSessionMode,
    });

  const {
    isAttemptRunning,
    stopExecution,
    clearStopping,
    isStopping,
    processes,
  } = useAttemptExecution(workspaceIdValue, taskId ?? undefined, sessionId);

  const { data: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus(workspaceIdValue);
  const { repos, selectedRepoId } = useAttemptRepo(workspaceIdValue);

  const repoWithConflicts = useMemo(
    () => getComposerRepoWithConflicts(branchStatus),
    [branchStatus]
  );
  const { branch: attemptBranch, refetch: refetchAttemptBranch } =
    useAttemptBranch(workspaceIdValue);
  const { comments, generateReviewMarkdown, clearComments } = useReview();

  const { enableScope, disableScope } = useHotkeysContext();

  const {
    entries,
    tokenUsageInfo,
    sessionModes,
    sessionConfigOptions,
    conversationPlanEntries,
    conversationTurnInFlight,
  } = useEntries();
  const isComposerExecutionRunning = isComposerExecutionActive({
    isAttemptRunning,
    isConversationTurnInFlight: conversationTurnInFlight,
  });
  const summaryRepoId = useMemo(
    () => getSummaryRepoId(selectedRepoId, repos),
    [repos, selectedRepoId]
  );
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
  const fileCount = useMemo(
    () =>
      getChangedFileCount({
        stagedFiles: summaryStagedFiles,
        unstagedFiles: summaryUnstagedFiles,
      }),
    [summaryStagedFiles, summaryUnstagedFiles]
  );
  const showChangedFileSummary = shouldShowChangedFileSummary(fileCount);

  const reviewMarkdown = useMemo(
    () => generateReviewMarkdown(),
    [generateReviewMarkdown]
  );

  const conflictResolutionInstructions = useMemo(
    () =>
      buildComposerConflictInstructions({
        attemptBranch,
        repoWithConflicts,
      }),
    [attemptBranch, repoWithConflicts]
  );

  const scratchIdValue = getComposerScratchTargetId({
    isNewSessionMode,
    workspaceId,
    sessionId,
  });

  const { isTextareaFocused, handleComposerFocus, handleComposerBlur } =
    useSessionComposerFocus();
  const {
    localMessage,
    setLocalMessage,
    attachedImages,
    setAttachedImages,
    attachedImagePaths,
    executorProfileRef,
  } = useSessionComposerLocalState();
  const {
    createdSessionProfiles,
    handleSelectSession,
    handleSessionCreated: handleFollowUpSessionCreated,
  } = useSessionComposerSessionCallbacks({
    workspaceId,
    selectSession,
    onSessionSelected,
    onSessionCreated,
    executorProfileRef,
  });
  const {
    scratchData,
    scratchExecutorProfile,
    deleteScratch,
    isScratchLoading,
    saveToScratch,
    setFollowUpMessage,
    cancelDebouncedSave,
  } = useSessionComposerDraftScratch({
    scratchId: scratchIdValue,
    workspaceId,
    attachedImagePaths,
    executorProfileRef,
  });
  const latestProfileId = useMemo(
    () => getLatestProfileFromProcesses(processes),
    [processes]
  );
  const defaultExecutorProfile = useMemo(() => {
    return getDefaultExecutorProfile({
      scratchExecutorProfile,
      latestProfileId,
      createdSessionProfiles,
      sessionId: session?.id,
      sessionExecutor: session?.executor as AgentKind | null | undefined,
      configExecutorProfile: config?.executor_profile,
      profiles,
    });
  }, [
    scratchExecutorProfile,
    latestProfileId,
    createdSessionProfiles,
    session?.id,
    session?.executor,
    config?.executor_profile,
    profiles,
  ]);

  const {
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    effectiveExecutorProfile,
  } = useSessionComposerProfileSelection(defaultExecutorProfile);

  // Publish the composer's effective profile so the conversation's reset-to-here
  // retry re-sends with the SAME model/variant selection (keeping the create form,
  // input box, and every actual turn — including resend — sourced identically).
  const { setActiveExecutorProfile } = useActiveExecutorProfile();
  useEffect(() => {
    setActiveExecutorProfile(effectiveExecutorProfile);
  }, [effectiveExecutorProfile, setActiveExecutorProfile]);

  useSessionComposerExecutorProfileHydration({
    scratchId: scratchIdValue,
    scratchExecutorProfile,
    defaultExecutorProfile,
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    effectiveExecutorProfile,
    executorProfileRef,
    isScratchLoading,
    localMessage,
    saveToScratch,
  });

  // Pending, agent-advertised mode selection applied to the next turn. Reset
  // when switching sessions so a picked mode never leaks across conversations.
  // Declared before draft hydration so a create-form preset can seed them.
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  // Pending ACP config-option selections (model / permission / …), key → value.
  const [selectedConfigValues, setSelectedConfigValues] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    setSelectedMode(null);
    setSelectedConfigValues({});
  }, [sessionId]);

  const { handleAfterSendCleanup } = useSessionComposerDraftHydration({
    scratchId: scratchIdValue,
    isScratchLoading,
    scratchData,
    setLocalMessage,
    setAttachedImages,
    setSelectedMode,
    setSelectedConfigValues,
    cancelDebouncedSave,
    deleteScratch,
  });

  const { activeRetryProcessId } = useRetryUi();
  const isRetryActive = !!activeRetryProcessId;

  const { handleRenameSession } = useSessionComposerSessionRename({
    workspaceId,
  });

  const {
    queueMessage,
    cancelQueue,
    isQueueLoading,
    isQueued,
    queueIndicatorState,
  } = useSessionComposerQueue({
    sessionId,
    workspaceId,
    isAttemptRunning: isComposerExecutionRunning,
    processCount: processes.length,
  });
  const handleEditQueuedMessage = useCallback(
    async (queuedMessage: QueuedMessage) => {
      setLocalMessage(queuedMessage.data.message);
      setAttachedImages(queuedMessage.data.images.map(imageAttachmentFromPath));
      await cancelQueue();
    },
    [cancelQueue, setAttachedImages, setLocalMessage]
  );

  const { notices: conversationStatusNotices } = useConversationStatus();
  // Live ACP session state is the sole source for composer controls. A global
  // agent catalog cannot account for workspace/provider/account differences.
  const displaySessionModes = sessionModes;
  const displaySessionConfigOptions = useMemo(
    () => visibleSessionConfigOptions(sessionConfigOptions),
    [sessionConfigOptions]
  );
  // A live `config_option_update` can replace an effort's choice set after a
  // model change. Keep pending next-turn values aligned with that update.
  useEffect(() => {
    setSelectedConfigValues((previous) => {
      const next = sanitizeDependentConfigValues(
        displaySessionConfigOptions,
        previous
      );
      return areConfigValuesEqual(previous, next) ? previous : next;
    });
  }, [displaySessionConfigOptions]);
  // Selecting a mode applies immediately via ACP `session/set_mode` when the
  // session is idle; while a turn is streaming (or before the session exists)
  // the backend rejects and the choice stays pending as a next-turn override.
  const handleSelectMode = useCallback(
    (modeId: string) => {
      setSelectedMode(modeId);
      if (!sessionId) return;
      void conversationApi
        .setSessionMode({ conversationId: sessionId, modeId })
        .then(() => setSelectedMode(null))
        .catch(() => {
          // Keep the pending selection; it is sent as modeOverride next turn.
        });
    },
    [sessionId]
  );

  // Same immediate-apply-or-defer contract for config options
  // (`session/set_config_option`): applied now when idle, next turn otherwise.
  const handleSelectConfigOption = useCallback(
    (key: string, value: string) => {
      // Resolve from the same snapshot rendered in the selector. In
      // particular, reject effort until a model is actually known and clear a
      // stale effort when switching models.
      const nextValues = selectConfigOptionValue(
        displaySessionConfigOptions,
        selectedConfigValues,
        key,
        value
      );
      const accepted = nextValues[key] === value;
      setSelectedConfigValues((previous) =>
        selectConfigOptionValue(
          displaySessionConfigOptions,
          previous,
          key,
          value
        )
      );
      if (!accepted) return;
      if (!sessionId) return;
      void conversationApi
        .setSessionConfigOption({ conversationId: sessionId, key, value })
        .then(() =>
          setSelectedConfigValues((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          })
        )
        .catch(() => {
          // Keep the pending selection; it is sent as a configOverride next turn.
        });
    },
    [displaySessionConfigOptions, selectedConfigValues, sessionId]
  );

  const pendingConfigOverrides = useMemo(
    () =>
      Object.entries(
        sanitizeDependentConfigValues(
          displaySessionConfigOptions,
          selectedConfigValues
        )
      ).map(([key, value]) => ({
        key,
        value,
      })),
    [displaySessionConfigOptions, selectedConfigValues]
  );

  // Once a turn is sent the pending mode/config overrides were applied by the
  // backend; clear them so they don't re-apply on every subsequent turn.
  const handleAfterSendWithSessionControlCleanup = useCallback(async () => {
    setSelectedMode(null);
    setSelectedConfigValues({});
    await handleAfterSendCleanup();
  }, [handleAfterSendCleanup]);
  const codexGoalState = useMemo(() => {
    if (
      effectiveExecutorProfile?.executor !== 'codex' &&
      effectiveExecutorProfile?.executor !== 'claude_code'
    ) {
      return null;
    }

    return deriveCodexGoalState(codexGoalEntriesFromConversation(entries));
  }, [effectiveExecutorProfile?.executor, entries]);
  const promptEnhancementContext = useMemo(
    () => buildPromptEnhancementContext(entries),
    [entries]
  );
  const { todos: legacyTodos } = useTodos(entries);
  const todos = useMemo(
    () =>
      conversationPlanEntries.length > 0
        ? conversationPlanEntries.map((entry) => ({
            ...entry,
            priority: entry.priority ?? null,
          }))
        : legacyTodos,
    [conversationPlanEntries, legacyTodos]
  );
  const hasPendingApproval = useMemo(
    () => hasPendingToolApproval(entries),
    [entries]
  );

  const { isSendingFollowUp, followUpError, setFollowUpError, onSendFollowUp } =
    useFollowUpSend({
      sessionId,
      sessionExecutor: session?.executor,
      workspaceId: workspaceIdValue,
      isNewSessionMode,
      newSessionName: '',
      onSelectSession: handleSelectSession,
      onSessionCreated: handleFollowUpSessionCreated,
      message: localMessage,
      images: attachedImagePaths,
      conflictMarkdown: conflictResolutionInstructions,
      reviewMarkdown,
      executorProfileId: effectiveExecutorProfile,
      modeOverride: selectedMode,
      configOverrides: pendingConfigOverrides,
      clearComments,
      onBeforeSend: clearStopping,
      onAfterSendCleanup: handleAfterSendWithSessionControlCleanup,
    });
  const { isCompactingContext, canCompactContext, handleCompactContext } =
    useSessionComposerContextCompact({
      sessionId,
      workspaceId: workspaceIdValue,
      executorProfile: effectiveExecutorProfile,
      processes,
      setFollowUpError,
      clearStopping,
      hasWorkspaceForTyping: Boolean(workspaceId),
      isSendingFollowUp,
      isRetryActive,
      hasPendingApproval,
      isAttemptRunning: isComposerExecutionRunning,
      isAwaitingNewSessionConfirmation,
      isNewSessionMode,
    });

  const canTypeFollowUp = useMemo(
    () =>
      getCanTypeFollowUp({
        hasWorkspace: !!workspaceId,
        isSendingFollowUp,
        isRetryActive,
        hasPendingApproval,
        isCompactingContext,
      }),
    [
      workspaceId,
      isSendingFollowUp,
      isRetryActive,
      hasPendingApproval,
      isCompactingContext,
    ]
  );

  const canSendFollowUp = useMemo(
    () =>
      getCanSendFollowUp({
        canType: canTypeFollowUp,
        hasExecutor: !!effectiveExecutorProfile?.executor,
        isAwaitingNewSessionConfirmation,
        isNewSessionMode,
        message: localMessage,
        conflictMarkdown: conflictResolutionInstructions,
        reviewMarkdown,
        imageCount: attachedImages.length,
      }),
    [
      canTypeFollowUp,
      effectiveExecutorProfile?.executor,
      isAwaitingNewSessionConfirmation,
      isNewSessionMode,
      localMessage,
      conflictResolutionInstructions,
      reviewMarkdown,
      attachedImages.length,
    ]
  );
  const canEnhancePrompt = useMemo(
    () =>
      getCanEnhancePrompt({
        canTypeFollowUp,
        draftPrompt: localMessage,
      }),
    [canTypeFollowUp, localMessage]
  );
  const isEditable = getCanEditFollowUp({
    isRetryActive,
    hasPendingApproval,
  });
  const conflictActionState = getConflictActionState({
    canSendFollowUp,
    isAttemptRunning: isComposerExecutionRunning,
    isEditable,
  });
  const showTopbar = getComposerTopbarVisibility({
    hasTokenUsageInfo: Boolean(tokenUsageInfo),
    hasCodexGoalState: Boolean(codexGoalState),
    showSessionSelector,
    sessionCount: sessions.length,
    hasExecutorProfile: Boolean(effectiveExecutorProfile?.executor),
  });

  const { handleQueueMessage, handleSubmitShortcut } =
    useSessionComposerSubmitActions({
      localMessage,
      conflictResolutionInstructions,
      reviewMarkdown,
      attachedImagePaths,
      effectiveExecutorProfile,
      isAttemptRunning: isComposerExecutionRunning,
      isQueued,
      clearStopping,
      cancelDebouncedSave,
      saveToScratch,
      queueMessage,
      onAfterQueueCleanup: () => {
        setLocalMessage('');
        setAttachedImages((prev) => {
          const cleanup = clearComposerImageAttachments(prev);
          cleanup.imagesToRevoke.forEach(revokeComposerImagePreviewUrl);
          return cleanup.attachments;
        });
      },
      onSendFollowUp,
    });

  const { handleEditorChange } = useSessionComposerEditorChange({
    sessionId,
    followUpError,
    setFollowUpError,
    setLocalMessage,
    setFollowUpMessage,
  });

  const getPreviewInsertionMessage = useCallback(
    () => localMessage,
    [localMessage]
  );

  useSessionComposerPreviewElementInsertion({
    enabled: isEditable,
    getMessage: getPreviewInsertionMessage,
    onChange: handleEditorChange,
  });

  const { handleAttachImages } = useSessionComposerImageUpload({
    workspaceId,
    sessionId,
    draftMessage: localMessage,
    executorProfile: executorProfileRef.current,
    saveToScratch,
    setAttachedImages,
  });

  const { handleRemoveImage } = useSessionComposerImageRemoval({
    draftMessage: localMessage,
    executorProfileRef,
    saveToScratch,
    setAttachedImages,
  });

  const { isEnhancingPrompt, handleEnhancePrompt } =
    useSessionComposerPromptEnhancement({
      draftPrompt: localMessage,
      sessionId,
      workspaceId,
      contextMessages: promptEnhancementContext,
      applyEnhancedPrompt: handleEditorChange,
      setFollowUpError,
    });

  useKeySubmitFollowUp(handleSubmitShortcut, {
    scope: Scope.FOLLOW_UP_READY,
    enableOnFormTags: ['textarea', 'TEXTAREA'],
    when: canSendFollowUp && isEditable,
  });

  useSessionComposerHotkeys({
    isEditable,
    isTextareaFocused,
    enableScope,
    disableScope,
  });

  useSessionComposerAttemptRefresh({
    isAttemptRunning: isComposerExecutionRunning,
    workspaceId,
    refetchBranchStatus,
    refetchAttemptBranch,
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
          'flex min-h-0 flex-col overflow-visible',
          isRetryActive && 'opacity-50'
        )}
      >
        {/* Scrollable content area */}
        <div className="min-h-0 overflow-y-auto px-3">
          <div className="space-y-2">
            <div className="space-y-2">
              <ReviewCommentsPreview reviewMarkdown={reviewMarkdown} />

              {branchStatus && (
                <FollowUpConflictSection
                  workspaceId={workspaceId}
                  attemptBranch={attemptBranch}
                  branchStatus={branchStatus}
                  isEditable={isEditable}
                  onResolve={onSendFollowUp}
                  enableResolve={conflictActionState.enableResolve}
                  enableAbort={conflictActionState.enableAbort}
                  conflictResolutionInstructions={
                    conflictResolutionInstructions
                  }
                />
              )}

              <MessageQueueIndicator
                isQueued={queueIndicatorState.isQueued}
                queuedMessage={queueIndicatorState.queuedMessage}
                messagePreview={queueIndicatorState.messagePreview}
                attachmentCount={queueIndicatorState.attachmentCount}
                onEditQueuedMessage={handleEditQueuedMessage}
                onDeleteQueuedMessage={cancelQueue}
              />
            </div>
          </div>
        </div>

        <ConversationStatusDock
          notices={conversationStatusNotices}
          localError={followUpError}
          onDismissLocalError={() => setFollowUpError(null)}
          dismissalScope={session?.id ?? null}
        />

        {/* Input area with buttons inside */}
        <div
          className="composer-shell relative z-10 mx-3 mb-3 mt-2 flex shrink-0 flex-col gap-1 overflow-visible rounded-xl p-2"
          data-typeahead-surface="composer"
          onFocus={handleComposerFocus}
          onBlur={handleComposerBlur}
        >
          {/* Top bar */}
          {showTopbar && (
            <SessionComposerTopbar
              executorProfile={effectiveExecutorProfile}
              sessionExecutor={session?.executor}
              showChangedFileSummary={showChangedFileSummary}
              changedFileCount={fileCount}
              added={added}
              deleted={deleted}
              codexGoalState={codexGoalState}
              tokenUsageInfo={tokenUsageInfo}
              todos={todos}
              showSessionSelector={showSessionSelector}
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              compactSessionLabel={compactSessionLabel}
              selectedSessionLabel={selectedSessionLabel}
              onJumpToPreviousUserMessage={onJumpToPreviousUserMessage}
              onSelectSession={handleSelectSession}
              onStartNewSession={() => onCreateSessionRequested?.()}
              onRenameSession={handleRenameSession}
            />
          )}
          <AgentMentionProvider
            transport={configuredBackendTransport}
            conversationId={sessionId}
          >
            <SessionComposerInput
              value={localMessage}
              onChange={handleEditorChange}
              disabled={!isEditable}
              context={{
                sendShortcut: config?.send_message_shortcut ?? 'Enter',
                taskAttemptId: workspaceId,
                taskId: taskId ?? undefined,
                workspaceId: workspaceIdValue,
                repoId: summaryRepoId ?? undefined,
                repoIds: repos.map((repo) => repo.id),
                executorProfile: effectiveExecutorProfile,
                sessionId,
                transport: configuredBackendTransport,
              }}
              images={attachedImages}
              onSubmit={handleSubmitShortcut}
              onAttachImages={handleAttachImages}
              onRemoveImage={handleRemoveImage}
            />
          </AgentMentionProvider>

          <ActionBar
            profiles={profiles}
            effectiveExecutorProfile={effectiveExecutorProfile}
            onChangeExecutorProfile={setSelectedExecutorProfile}
            showProfileControls={true}
            sessionModes={displaySessionModes}
            selectedMode={selectedMode}
            onSelectMode={handleSelectMode}
            sessionConfigOptions={displaySessionConfigOptions}
            selectedConfigValues={selectedConfigValues}
            onSelectConfigOption={handleSelectConfigOption}
            isEditable={isEditable}
            isAttemptRunning={isComposerExecutionRunning}
            isQueued={queueIndicatorState.isQueued}
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
            attachmentCount={attachedImages.length}
            conflictResolutionInstructions={conflictResolutionInstructions}
            reviewMarkdown={reviewMarkdown}
            comments={comments}
            onCompactContext={handleCompactContext}
            onQueueMessage={handleQueueMessage}
            onCancelQueue={cancelQueue}
            onStopExecution={stopExecution}
            onSendFollowUp={onSendFollowUp}
            onEnhancePrompt={handleEnhancePrompt}
            onClearComments={clearComments}
            onAttachImages={handleAttachImages}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
