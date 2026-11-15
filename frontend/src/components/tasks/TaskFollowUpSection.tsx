import { TooltipProvider } from '@/components/ui/tooltip';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { AgentKind } from 'shared/types';
import { useBranchStatus } from '@/hooks';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { cn } from '@/lib/utils';
import { useReview } from '@/contexts/ReviewProvider';
import { useEntries } from '@/contexts/EntriesContext';
import { useConversationStatus } from '@/contexts/ConversationStatusContext';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useUserSystem } from '@/components/ConfigProvider';
import { useAttemptBranch } from '@/hooks/useAttemptBranch';
import { FollowUpConflictSection } from '@/components/tasks/follow-up/FollowUpConflictSection';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useActiveExecutorProfile } from '@/contexts/ActiveExecutorProfileContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  clearConversationPromptSuggestion,
  getConversationAsyncTasks,
  getConversationPersona,
  getConversationPromptSuggestion,
  getConversationSessionGoal,
  subscribeConversationTimeline,
} from '@/features/conversation/conversationTimelineRegistry';
import { sessionsApi } from '@/lib/api';
import { listenToConversationEvents } from '@/features/conversation/events';
import { listenToAgentEvents } from '@/features/agents/events';
import {
  composerSessionControlDisplay,
  liveSessionControlsSnapshot,
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';

import type { Session, Workspace } from 'shared/types';
import { buildPromptEnhancementContext } from '@/lib/promptEnhancement';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useParams } from 'react-router-dom';

import { ReviewCommentsPreview } from './follow-up/ReviewCommentsPreview';
import { MessageQueueIndicator } from './follow-up/MessageQueueIndicator';
import { ActionBar } from './follow-up/ActionBar';
import {
  ComposerEngineHandoffModal,
  useComposerEngineHandoff,
} from './follow-up/ComposerEngineHandoffControl';
import { resolveSessionModelDisplayLabel } from './follow-up/SessionSettingsSummary';
import { ConversationStatusDock } from './follow-up/ConversationStatusDock';
import { ConversationChildrenSummary } from '@/features/conversation/ConversationChildrenSummary';
import { AgentQuestionCard } from './follow-up/AgentQuestionCard';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { RateLimitRecoveryBanner } from '@/components/NormalizedConversation/RateLimitRecoveryBanner';
import { SessionAsyncTaskBar } from '@/components/NormalizedConversation/conversation/SessionAsyncTaskBar';
import { SessionGoalBar } from '@/components/NormalizedConversation/conversation/SessionGoalBar';
import {
  areConfigValuesEqual,
  dropPendingConfigValueAfterRejection,
  dropPendingModeAfterRejection,
  reconcilePendingConfigValues,
  reconcilePendingMode,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from './follow-up/SessionConfigOptionSelectors';
import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from './follow-up/SessionComposerInput';
import { SessionComposerFrame } from './follow-up/SessionComposerFrame';
import { AgentMentionProvider } from './follow-up/AgentMention';
import { LiveFeedbackNotes } from './follow-up/LiveFeedbackBar';
import { getDefaultExecutorProfile } from './follow-up/sessionComposerDraft';
import {
  clearComposerImageAttachments,
  imageAttachmentFromPath,
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from './follow-up/sessionComposerImages';
import { getSummaryRepoId } from './follow-up/sessionComposerGitSummary';
import {
  buildComposerConflictInstructions,
  getConflictActionState,
  getComposerRepoWithConflicts,
} from './follow-up/sessionComposerConflicts';
import {
  getComposerSessionId,
  getComposerScratchTargetId,
  getComposerWorkspaceId,
} from './follow-up/sessionComposerSession';
import {
  canEditFollowUp as getCanEditFollowUp,
  canSendFollowUp as getCanSendFollowUp,
  canTypeFollowUp as getCanTypeFollowUp,
  getBeforeSendCleanup,
  hasPendingToolApproval,
  isComposerExecutionActive,
  restoreComposerAttachmentsAfterSendFailure,
} from './follow-up/sessionComposerSubmit';
import {
  executeComposerSteer,
  getQueueSteerChannel,
  resolveQueuePromoteSteeringTarget,
} from './follow-up/sessionComposerSteering';
import { canEnhancePrompt as getCanEnhancePrompt } from './follow-up/sessionComposerPromptEnhancement';
import { useSessionComposerPromptEnhancement } from './follow-up/useSessionComposerPromptEnhancement';
import { useSessionComposerContextCompact } from './follow-up/useSessionComposerContextCompact';
import { useSessionComposerQueue } from './follow-up/useSessionComposerQueue';
import { useSessionComposerImageUpload } from './follow-up/useSessionComposerImageUpload';
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
  codexGoalStateFromSessionGoal,
  deriveCodexGoalState,
} from '@/lib/codexGoalState';
import { requestConversationScrollToGoal } from '@/lib/conversationScroll';
import { configuredBackendTransport } from '@/lib/backendTransport';
import { createPluginControlApi } from '@/lib/api/plugins';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { useConversationAvailableCommands } from '@/features/conversation/useConversationAvailableCommands';
import { conversationThreadMaxWidthClass } from '@/components/NormalizedConversation/ConversationTimeline';
import { useLayoutStore } from '@/stores/useLayoutStore';

interface TaskFollowUpSectionProps {
  taskId?: string | null;
  session?: Session;
  workspace?: Workspace;
  workspaceId?: string;
  widthMode?: 'bounded' | 'workspace';
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
    'selectSession' | 'isNewSessionMode'
  >;
}

export function TaskFollowUpSection({
  taskId,
  session,
  workspace,
  workspaceId: workspaceIdProp,
  widthMode = 'bounded',
  onSessionCreated,
  onSessionSelected,
  sessionState,
}: TaskFollowUpSectionProps) {
  const { t } = useTranslation('app');
  const isEditorAreaVisible = useLayoutStore(
    (state) => state.isEditorAreaVisible
  );
  const composerMaxWidthClass = conversationThreadMaxWidthClass(
    widthMode,
    isEditorAreaVisible
  );
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
  const { selectSession, isNewSessionMode } = sessionState;
  const isAwaitingNewSessionConfirmation = false;
  const sessionId = getComposerSessionId({
    isNewSessionMode,
    sessionId: session?.id,
  });
  const storedPersona = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationPersona(sessionId ?? null),
    () => getConversationPersona(sessionId ?? null)
  );
  const storedSessionGoal = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationSessionGoal(sessionId ?? null),
    () => getConversationSessionGoal(sessionId ?? null)
  );
  const storedAsyncTasks = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationAsyncTasks(sessionId ?? null),
    () => getConversationAsyncTasks(sessionId ?? null)
  );
  const storedPromptSuggestion = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationPromptSuggestion(sessionId ?? null),
    () => getConversationPromptSuggestion(sessionId ?? null)
  );
  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId && previousSessionId !== sessionId) {
      clearConversationPromptSuggestion(previousSessionId);
    }
    previousSessionIdRef.current = sessionId;
  }, [sessionId]);
  const liveCommands = useConversationAvailableCommands(sessionId);
  const { profiles, config } = useUserSystem();

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
  const composerWorkspacePath = useMemo(
    () =>
      deriveWorkspaceRootPath(workspace, repos) ??
      repos.find((repo) => repo.id === selectedRepoId)?.path ??
      repos[0]?.path ??
      undefined,
    [repos, selectedRepoId, workspace]
  );

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
    sessionModes,
    sessionConfigOptions,
    conversationTurnInFlight,
    conversationSteeringTurnId,
    conversationSteeringTarget,
    conversationDeliveryChannel,
    userMessageHistory,
  } = useEntries();
  const isComposerExecutionRunning = isComposerExecutionActive({
    isAttemptRunning,
    isConversationTurnInFlight: conversationTurnInFlight,
  });
  const steeringTarget = useMemo(
    () =>
      conversationSteeringTarget ??
      (conversationSteeringTurnId
        ? { turnId: conversationSteeringTurnId, mode: 'native' as const }
        : null),
    [conversationSteeringTarget, conversationSteeringTurnId]
  );
  const pluginApi = useMemo(
    () => createPluginControlApi(configuredBackendTransport),
    []
  );
  const { data: liveFeedbackOn } = useQuery({
    queryKey: ['official-product-mcp-feedback'],
    queryFn: async () => {
      const mcpState = await pluginApi.officialProductMcpState();
      return mcpState.feedback;
    },
    staleTime: 5_000,
  });
  const { data: liveFeedbackNotes = [], refetch: refetchLiveFeedback } =
    useQuery({
      queryKey: ['conversation-live-feedback', sessionId],
      queryFn: async () => {
        if (!sessionId) return [];
        return conversationApi.listFeedback(sessionId);
      },
      enabled: Boolean(sessionId && liveFeedbackOn),
      // Events are the fast path; this only converges after a missed host event.
      refetchInterval: liveFeedbackOn ? 15_000 : false,
    });
  useEffect(() => {
    if (!sessionId || !liveFeedbackOn) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    listenToConversationEvents((batch) => {
      if (!active || batch.conversation_id !== sessionId) return;
      if (
        batch.ops.length > 0 &&
        batch.ops.every((op) => op.op === 'append_text')
      ) {
        return;
      }
      void refetchLiveFeedback();
    }, sessionId)
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [liveFeedbackOn, refetchLiveFeedback, sessionId]);
  const summaryRepoId = useMemo(
    () => getSummaryRepoId(selectedRepoId, repos),
    [repos, selectedRepoId]
  );

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
    lastSavedRevision,
    scratchRevision,
  } = useSessionComposerDraftScratch({
    scratchId: scratchIdValue,
    workspaceId,
    attachedImagePaths,
    executorProfileRef,
    localMessage,
  });
  const resolvedSessionExecutor = (session?.agent_id ??
    session?.executor ??
    storedPersona?.agent_name) as AgentKind | null | undefined;
  const defaultExecutorProfile = useMemo(() => {
    return getDefaultExecutorProfile({
      scratchExecutorProfile,
      latestProfileId: null,
      createdSessionProfiles,
      sessionId: session?.id,
      sessionExecutor: resolvedSessionExecutor,
      configExecutorProfile: config?.executor_profile,
      profiles,
    });
  }, [
    scratchExecutorProfile,
    createdSessionProfiles,
    session?.id,
    resolvedSessionExecutor,
    config?.executor_profile,
    profiles,
  ]);

  const {
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    effectiveExecutorProfile,
  } = useSessionComposerProfileSelection(defaultExecutorProfile);
  const targetExecutor = effectiveExecutorProfile?.executor ?? resolvedSessionExecutor;
  const isChangingAgent = Boolean(resolvedSessionExecutor && targetExecutor !== resolvedSessionExecutor);
  const [continuationPolicy, setContinuationPolicy] = useState<'portable' | 'fresh'>('portable');

  // Publish the composer's effective profile so the conversation's reset-to-here
  // retry re-sends with the SAME model/variant selection (keeping the create form,
  // input box, and every actual turn — including resend — sourced identically).
  const { setActiveExecutorProfile, setPendingAgentHandoff } =
    useActiveExecutorProfile();
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
  }, [sessionId, targetExecutor, resolvedSessionExecutor]);
  useEffect(() => {
    setContinuationPolicy('portable');
  }, [sessionId]);

  const { handleAfterSendCleanup } = useSessionComposerDraftHydration({
    scratchId: scratchIdValue,
    isScratchLoading,
    scratchData,
    localMessage,
    setLocalMessage,
    setAttachedImages,
    setSelectedMode,
    setSelectedConfigValues,
    cancelDebouncedSave,
    deleteScratch,
    savedRevision: lastSavedRevision,
    serverRevision: scratchRevision,
  });

  const { activeRetryProcessId } = useRetryUi();
  const isRetryActive = !!activeRetryProcessId;

  const [pendingSendOperationId, setPendingSendOperationId] = useState<
    string | null
  >(null);

  const {
    queueMessage,
    cancelQueue,
    refreshQueueStatus,
    beginEditQueue,
    editingInput,
    moveQueue,
    delayQueue,
    isQueued,
    queueIndicatorState,
  } = useSessionComposerQueue({
    sessionId,
    workspaceId,
    isAttemptRunning: isComposerExecutionRunning,
    processCount: processes.length,
    continuationPolicy,
    modeOverride: selectedMode,
    configOverrides: Object.entries(selectedConfigValues).map(
      ([key, value]) => ({
        key,
        value,
      })
    ),
    excludeOperationId: pendingSendOperationId,
  });
  const handleEditQueuedMessage = useCallback(
    (queuedMessage: QueuedMessage) => {
      beginEditQueue(queuedMessage);
      setLocalMessage(queuedMessage.data.message ?? '');
      setAttachedImages(queuedMessage.data.images.map(imageAttachmentFromPath));
    },
    [beginEditQueue, setAttachedImages, setLocalMessage]
  );

  const {
    notices: conversationStatusNotices,
    question: pendingAgentQuestion,
    permissions: pendingPermissions,
    childrenDock,
    rateLimit: activeRateLimit,
    sessionBindReady,
  } = useConversationStatus();
  const engineHandoff = useComposerEngineHandoff({
    sessionId,
    hasExistingTurns: Boolean(sessionId && entries.length > 0),
    currentExecutor:
      effectiveExecutorProfile?.executor ?? resolvedSessionExecutor ?? null,
    onApplyExecutorProfile: setSelectedExecutorProfile,
  });
  const autoCreatedNewSessionRef = useRef(false);
  useEffect(() => {
    if (!isNewSessionMode) {
      autoCreatedNewSessionRef.current = false;
      return;
    }
    const executorId = effectiveExecutorProfile?.executor;
    if (autoCreatedNewSessionRef.current || !workspaceId || !executorId) {
      return;
    }
    autoCreatedNewSessionRef.current = true;
    void sessionsApi
      .create({
        workspace_id: workspaceId,
        executor: executorId,
      })
      .then((created) => {
        handleSelectSession(created.id);
        handleFollowUpSessionCreated({
          sessionId: created.id,
          workspaceId: created.workspace_id,
        });
      })
      .catch((error: unknown) => {
        autoCreatedNewSessionRef.current = false;
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [
    effectiveExecutorProfile?.executor,
    handleFollowUpSessionCreated,
    handleSelectSession,
    isNewSessionMode,
    workspaceId,
  ]);
  const executor = targetExecutor ?? null;
  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(executor ?? '', null),
    queryFn: () => loadAgentSessionControlsCatalog(executor),
    enabled: Boolean(executor),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });
  const workspaceControlsQuery = useQuery({
    queryKey: sessionControlsQueryKey(executor ?? '', workspaceId ?? ''),
    queryFn: () => loadAgentSessionControlsCatalog(executor!),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(executor ?? ''),
    queryFn: () => loadAgentSessionControlsCatalog(executor!),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const displayControls = useMemo(
    () =>
      composerSessionControlDisplay([
        isChangingAgent ? null : liveSessionControlsSnapshot(sessionModes, sessionConfigOptions),
        workspaceControlsQuery.data,
        catalogQuery.data,
        schemaQuery.data,
      ]),
    [
      sessionModes,
      isChangingAgent,
      sessionConfigOptions,
      workspaceControlsQuery.data,
      catalogQuery.data,
      schemaQuery.data,
    ]
  );
  const displaySessionModes = displayControls.sessionModes;
  const liveModeId = displaySessionModes.current;
  const displaySessionConfigOptions = useMemo(
    () => visibleSessionConfigOptions(displayControls.sessionConfigOptions),
    [displayControls.sessionConfigOptions]
  );
  const fromModelLabel = useMemo(
    () => resolveSessionModelDisplayLabel(sessionConfigOptions, {}),
    [sessionConfigOptions]
  );
  const toModelLabel = useMemo(
    () =>
      resolveSessionModelDisplayLabel(
        displaySessionConfigOptions,
        selectedConfigValues
      ),
    [displaySessionConfigOptions, selectedConfigValues]
  );
  useEffect(() => {
    if (
      !isNewSessionMode &&
      sessionId &&
      isChangingAgent &&
      resolvedSessionExecutor &&
      targetExecutor
    ) {
      setPendingAgentHandoff({
        sessionId,
        fromAgent: resolvedSessionExecutor,
        toAgent: targetExecutor,
        fromModelLabel,
        toModelLabel,
        continuationPolicy,
      });
      return;
    }
    setPendingAgentHandoff(null);
  }, [
    continuationPolicy,
    fromModelLabel,
    isChangingAgent,
    isNewSessionMode,
    resolvedSessionExecutor,
    sessionId,
    setPendingAgentHandoff,
    targetExecutor,
    toModelLabel,
  ]);
  useEffect(
    () => () => {
      setPendingAgentHandoff(null);
    },
    [setPendingAgentHandoff]
  );
  // A live `config_option_update` can replace an effort's choice set after a
  // model change. Keep pending next-turn values aligned with that update, and
  // only drop a selection once the live snapshot actually carries it.
  useEffect(() => {
    setSelectedConfigValues((previous) => {
      const next = reconcilePendingConfigValues(
        displaySessionConfigOptions,
        previous
      );
      return areConfigValuesEqual(previous, next) ? previous : next;
    });
  }, [displaySessionConfigOptions]);
  useEffect(() => {
    setSelectedMode((previous) => reconcilePendingMode(liveModeId, previous));
  }, [liveModeId]);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenToAgentEvents((envelope) => {
      if (!active || envelope.session_id !== sessionId) return;
      if (envelope.event.kind !== 'config_option_rejected') return;
      const rejection = envelope.event;
      setSelectedMode((previous) =>
        dropPendingModeAfterRejection(rejection, previous)
      );
      setSelectedConfigValues((previous) =>
        dropPendingConfigValueAfterRejection(rejection.config_id, previous)
      );
    }).then((unsubscribe) => {
      if (!active) {
        unsubscribe();
        return;
      }
      unlisten = unsubscribe;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId]);
  // Selecting a mode applies immediately via ACP `session/set_mode` when the
  // session is idle; while a turn is streaming (or before the session exists)
  // the backend rejects and the choice stays pending as a next-turn override.
  const handleSelectMode = useCallback(
    (modeId: string) => {
      setSelectedMode(modeId);
      if (!sessionId || isChangingAgent) return;
      void conversationApi
        .setSessionMode({ conversationId: sessionId, modeId })
        .catch(() => {
          // Keep the pending selection; it is sent as modeOverride next turn.
        });
    },
    [sessionId, isChangingAgent]
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
      if (!sessionId || isChangingAgent) return;
      void conversationApi
        .setSessionConfigOption({ conversationId: sessionId, key, value })
        .catch(() => {
          // Keep the pending selection; it is sent as a configOverride next turn.
        });
    },
    [displaySessionConfigOptions, selectedConfigValues, sessionId, isChangingAgent]
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

  // Pending mode/config stay until the live snapshot matches or the agent
  // rejects the pick. Clearing them on send races the ACP answer and makes
  // Codex/Grok selectors snap to a reverted current.
  const sentAttachmentsRef = useRef<SessionComposerImageAttachment[]>([]);
  const handleAfterSendWithSessionControlCleanup = useCallback(async () => {
    sentAttachmentsRef.current.forEach(revokeComposerImagePreviewUrl);
    sentAttachmentsRef.current = [];
    setContinuationPolicy('portable');
    await handleAfterSendCleanup();
  }, [handleAfterSendCleanup]);
  const handleBeforeSend = useCallback(() => {
    cancelDebouncedSave();
    clearStopping();
    setLocalMessage('');
    setAttachedImages((prev) => {
      const cleanup = getBeforeSendCleanup(prev);
      sentAttachmentsRef.current = cleanup.sentAttachments;
      return cleanup.attachments;
    });
  }, [cancelDebouncedSave, clearStopping, setAttachedImages, setLocalMessage]);
  const handleSendFailure = useCallback(
    (failedMessage: string) => {
      cancelDebouncedSave();
      setLocalMessage((current) => (current ? current : failedMessage));
      setAttachedImages((current) => {
        const restored = restoreComposerAttachmentsAfterSendFailure({
          currentAttachments: current,
          sentAttachments: sentAttachmentsRef.current,
        });
        sentAttachmentsRef.current = [];
        return restored;
      });
    },
    [cancelDebouncedSave, setAttachedImages, setLocalMessage]
  );
  const codexGoalState = useMemo(() => {
    const liveGoal = codexGoalStateFromSessionGoal(storedSessionGoal);
    if (liveGoal) {
      return liveGoal;
    }
    if (storedSessionGoal?.actions != null) {
      return null;
    }
    if (
      effectiveExecutorProfile?.executor !== 'codex' &&
      effectiveExecutorProfile?.executor !== 'claude_code'
    ) {
      return null;
    }

    return deriveCodexGoalState(codexGoalEntriesFromConversation(entries));
  }, [effectiveExecutorProfile?.executor, entries, storedSessionGoal]);
  const handleGoalControl = useCallback(
    (action: 'pause' | 'clear') => {
      if (!sessionId) {
        return Promise.resolve({
          action,
          method: '_session/goal',
          should_interrupt_turn: false,
        });
      }
      return conversationApi.goalControl(sessionId, action);
    },
    [sessionId]
  );
  const handleStopAsyncTask = useCallback(
    async (taskId: string) => {
      if (!sessionId) return false;
      const res = await conversationApi.stopAsyncTask(sessionId, taskId);
      return Boolean(res?.stopped);
    },
    [sessionId]
  );
  const promptEnhancementContext = useMemo(
    () => buildPromptEnhancementContext(entries),
    [entries]
  );
  const hasPendingApproval = useMemo(
    () => hasPendingToolApproval(entries),
    [entries]
  );

  const {
    isSendingFollowUp,
    followUpError,
    setFollowUpError,
    onSendFollowUp,
    onSubmitFollowUp,
  } = useFollowUpSend({
    sessionId,
    continuationPolicy,
    sessionExecutor: resolvedSessionExecutor,
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
    onBeforeSend: handleBeforeSend,
    onSendFailure: handleSendFailure,
    onAfterSendCleanup: handleAfterSendWithSessionControlCleanup,
    onPendingOperationIdChange: setPendingSendOperationId,
  });
  const [isSteering, setIsSteering] = useState(false);
  const queueSteerChannel = getQueueSteerChannel({
    isTurnInFlight: conversationTurnInFlight,
    steeringSupported: steeringTarget?.mode === 'native',
    currentTurnId: steeringTarget?.turnId ?? null,
    deliveryChannel: conversationDeliveryChannel,
    sessionEnhanceFeedbackOn: Boolean(liveFeedbackOn),
  });
  const handleSteerQueuedMessage = useCallback(
    async (queuedMessage: QueuedMessage) => {
      if (!sessionId || queuedMessage.status !== 'queued') return;
      const followUp = {
        message: queuedMessage.data.agentMessage ?? queuedMessage.data.message,
        images: queuedMessage.data.images,
        pluginActions: queuedMessage.data.pluginActions,
      };
      const promoteTarget = resolveQueuePromoteSteeringTarget({
        queueSteerChannel,
        steeringTarget,
        followUp,
      });
      setIsSteering(true);
      try {
        await executeComposerSteer({
          sessionId,
          previousDraft: queuedMessage.data.message,
          followUp,
          steeringTarget: promoteTarget,
          promotedInputId: queuedMessage.id,
          expectedRevision: Number(queuedMessage.revision),
          allowInterruptRestart: promoteTarget?.mode === 'interrupt_restart',
          steer: (args) => conversationApi.steer(args),
          submitFeedback: (args) => conversationApi.submitFeedback(args),
          onAfterSuccess: async (meta) => {
            if (meta?.consumedPromotedInputAtomically) {
              await refreshQueueStatus();
            } else {
              await cancelQueue(queuedMessage);
            }
          },
          onRestoreDraft: () => undefined,
          onError: setFollowUpError,
          onToastError: (message) => toast.error(message),
          messages: {
            pluginBlocked: t('tasks:composer.steerPluginBlocked'),
            imagesBlocked: t('tasks:composer.steerImagesBlocked'),
            turnEnded: t('tasks:composer.steerTurnEnded'),
            unknown: t('tasks:composer.steerUnknown'),
            rejected: t('tasks:composer.steerRejected'),
          },
        });
      } finally {
        setIsSteering(false);
      }
    },
    [
      cancelQueue,
      queueSteerChannel,
      refreshQueueStatus,
      sessionId,
      setFollowUpError,
      steeringTarget,
      t,
    ]
  );
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
        sessionBindReady,
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
      sessionBindReady,
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

  const { handleComposerSubmit } = useSessionComposerSubmitActions({
    localMessage,
    conflictResolutionInstructions,
    reviewMarkdown,
    attachedImagePaths,
    effectiveExecutorProfile,
    isAttemptRunning: isComposerExecutionRunning,
    isQueued,
    isEditingQueued: Boolean(editingInput),
    canSendFollowUp,
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
    onSubmitFollowUp,
  });

  const { handleEditorChange } = useSessionComposerEditorChange({
    sessionId,
    followUpError,
    setFollowUpError,
    setLocalMessage,
    setFollowUpMessage,
  });
  const composerReplaceValueRef = useRef<((next: string) => void) | null>(null);
  const applyEnhancedPrompt = useCallback(
    (prompt: string) => {
      const replaceValue = composerReplaceValueRef.current;
      if (replaceValue) {
        replaceValue(prompt);
        return;
      }
      handleEditorChange(prompt);
    },
    [handleEditorChange]
  );

  const getPreviewInsertionMessage = useCallback(
    () => localMessage,
    [localMessage]
  );

  const { markFocused: markDraftTargetFocused } =
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
    onError: (error) =>
      setFollowUpError(
        t('followUpSend.imageUploadFailed', {
          error,
        })
      ),
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
      applyEnhancedPrompt,
      setFollowUpError,
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

  const localMessageRef = useRef(localMessage);
  localMessageRef.current = localMessage;

  const onSendFollowUpRef = useRef(onSendFollowUp);
  onSendFollowUpRef.current = onSendFollowUp;

  const handleStableSendFollowUp = useCallback(() => {
    void onSendFollowUpRef.current();
  }, []);

  const getLatestDraftValue = useCallback(
    () => localMessageRef.current ?? '',
    []
  );

  const handleStashDraft = useCallback(() => {
    if (composerReplaceValueRef.current) {
      composerReplaceValueRef.current('');
    } else {
      handleEditorChange('');
    }
  }, [handleEditorChange]);

  const handleRestoreDraft = useCallback(
    (restoredText: string) => {
      if (composerReplaceValueRef.current) {
        composerReplaceValueRef.current(restoredText);
      } else {
        handleEditorChange(restoredText);
      }
    },
    [handleEditorChange]
  );

  const handleDismissPromptSuggestion = useCallback(() => {
    if (sessionId) {
      clearConversationPromptSuggestion(sessionId);
    }
  }, [sessionId]);

  const handleResendLiveFeedback = useCallback(
    (text?: string) => {
      setLocalMessage(text ?? '');
    },
    [setLocalMessage]
  );

  const repoIds = useMemo(() => repos.map((repo) => repo.id), [repos]);

  const composerInputContext = useMemo(
    () => ({
      workspaceId: workspaceIdValue,
      workspacePath: composerWorkspacePath,
      repoId: summaryRepoId ?? undefined,
      repoIds,
      executorProfile: effectiveExecutorProfile,
      sessionId,
      availableCommands: liveCommands.commands,
      commandsLoading: liveCommands.loading,
      transport: configuredBackendTransport,
    }),
    [
      composerWorkspacePath,
      configuredBackendTransport,
      effectiveExecutorProfile,
      liveCommands.commands,
      liveCommands.loading,
      repoIds,
      sessionId,
      summaryRepoId,
      workspaceIdValue,
    ]
  );

  const continuationConfig = useMemo(
    () =>
      sessionId && entries.length > 0
        ? {
            policy: continuationPolicy,
            onChange: setContinuationPolicy,
          }
        : null,
    [continuationPolicy, entries.length, sessionId]
  );

  const hasDraft = Boolean(localMessage?.trim());

  if (!workspaceId) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'flex shrink-0 flex-col overflow-visible',
          isRetryActive && 'opacity-50'
        )}
      >
        {/* Scrollable content area */}
        <div className="min-h-0 overflow-y-auto px-3">
          <div className={cn('mx-auto w-full space-y-2', composerMaxWidthClass)}>
            <ReviewCommentsPreview reviewMarkdown={reviewMarkdown} />

            {branchStatus && (
              <FollowUpConflictSection
                workspaceId={workspaceId}
                attemptBranch={attemptBranch}
                branchStatus={branchStatus}
                enableResolve={conflictActionState.enableResolve}
                enableAbort={conflictActionState.enableAbort}
                conflictResolutionInstructions={
                  conflictResolutionInstructions
                }
              />
            )}

            <SessionGoalBar
              sessionGoal={storedSessionGoal}
              fallbackGoal={codexGoalState}
              sessionBindReady={sessionBindReady}
              onGoalControl={sessionId ? handleGoalControl : undefined}
              onSelectGoal={
                sessionId
                  ? () => requestConversationScrollToGoal(sessionId)
                  : undefined
              }
            />

            <SessionAsyncTaskBar
              tasks={storedAsyncTasks}
              sessionBindReady={sessionBindReady}
              onStopTask={sessionId ? handleStopAsyncTask : undefined}
            />

            <MessageQueueIndicator
              isQueued={queueIndicatorState.isQueued}
              queuedMessages={queueIndicatorState.queuedMessages}
              delayedMessages={queueIndicatorState.delayedMessages}
              canSteerQueued={Boolean(queueSteerChannel)}
              steerChannel={queueSteerChannel}
              steeringQueued={isSteering}
              onSteerQueuedMessage={handleSteerQueuedMessage}
              onEditQueuedMessage={handleEditQueuedMessage}
              onDeleteQueuedMessage={cancelQueue}
              onMoveQueuedMessage={moveQueue}
              onDelayQueuedMessage={delayQueue}
            />

            {activeRateLimit ? (
              <RateLimitRecoveryBanner
                conversationId={activeRateLimit.conversationId}
                rateLimit={activeRateLimit.state}
                onUpdateAutoResume={activeRateLimit.onUpdateAutoResume}
                onCancelWait={activeRateLimit.onCancelWait}
              />
            ) : null}
          </div>
        </div>

        <SessionComposerFrame
          widthClassName={composerMaxWidthClass}
          status={
            <ConversationStatusDock
              notices={conversationStatusNotices}
              localError={followUpError}
              onDismissLocalError={() => setFollowUpError(null)}
              dismissalScope={session?.id ?? null}
              extra={
                childrenDock ? (
                  <ConversationChildrenSummary
                    conversationId={childrenDock.conversationId}
                    onOpenChild={childrenDock.onOpenChild}
                  />
                ) : null
              }
            />
          }
          overlay={
            pendingPermissions.length > 0 || pendingAgentQuestion ? (
              <div className="space-y-2">
                {pendingPermissions.map((permission) => (
                  <PermissionRequestCard
                    key={permission.request.permission_id}
                    request={permission.request}
                    responding={permission.responding}
                    onRespond={permission.onRespond}
                  />
                ))}
                {pendingAgentQuestion ? (
                  <AgentQuestionCard
                    key={pendingAgentQuestion.request.question_id}
                    request={pendingAgentQuestion.request}
                    responding={pendingAgentQuestion.responding}
                    onRespond={pendingAgentQuestion.onRespond}
                  />
                ) : null}
              </div>
            ) : null
          }
          drawer={
            <SessionComposerAttachmentDrawer
              images={attachedImages}
              disabled={!isEditable}
              taskAttemptId={workspaceId}
              taskId={taskId ?? undefined}
              onRemoveImage={handleRemoveImage}
            />
          }
          onFocus={() => {
            markDraftTargetFocused();
            handleComposerFocus();
          }}
          onBlur={handleComposerBlur}
        >
          <LiveFeedbackNotes
            notes={liveFeedbackNotes}
            conversationId={sessionId}
            onResend={handleResendLiveFeedback}
          />
          <AgentMentionProvider
            transport={configuredBackendTransport}
            conversationId={sessionId}
          >
            <SessionComposerInput
              value={localMessage ?? ''}
              onChange={handleEditorChange}
              replaceValueRef={composerReplaceValueRef}
              disabled={!isEditable}
              promptSuggestion={
                isEditable &&
                canTypeFollowUp &&
                !isComposerExecutionRunning &&
                !editingInput
                  ? storedPromptSuggestion
                  : null
              }
              onDismissPromptSuggestion={handleDismissPromptSuggestion}
              messageHistory={userMessageHistory}
              context={composerInputContext}
              onSubmit={handleComposerSubmit}
              onAttachImages={handleAttachImages}
            />
          </AgentMentionProvider>

          <ActionBar
            profiles={profiles}
            effectiveExecutorProfile={effectiveExecutorProfile}
            onChangeExecutorProfile={engineHandoff.handleChangeExecutorProfile}
            sessionModes={displaySessionModes}
            selectedMode={selectedMode}
            onSelectMode={handleSelectMode}
            sessionConfigOptions={displaySessionConfigOptions}
            selectedConfigValues={selectedConfigValues}
            onSelectConfigOption={handleSelectConfigOption}
            sessionControlsLoading={catalogQuery.isLoading}
            continuation={continuationConfig}
            isEditable={isEditable}
            isAttemptRunning={isComposerExecutionRunning}
            compactContextEnabled={config?.compact_context_enabled ?? false}
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
            conflictResolutionInstructions={conflictResolutionInstructions}
            hasComments={comments.length > 0}
            sendShortcut={config?.send_message_shortcut ?? 'Enter'}
            onCompactContext={handleCompactContext}
            onStopExecution={stopExecution}
            onSendFollowUp={handleStableSendFollowUp}
            onEnhancePrompt={handleEnhancePrompt}
            onClearComments={clearComments}
            onAttachImages={handleAttachImages}
            stashScopeId={workspaceIdValue ?? sessionId ?? 'global'}
            hasDraft={hasDraft}
            getDraftValue={getLatestDraftValue}
            attachmentCount={attachedImages.length}
            onStashDraft={handleStashDraft}
            onRestoreDraft={handleRestoreDraft}
          />
        </SessionComposerFrame>
        <ComposerEngineHandoffModal controller={engineHandoff} />
      </div>
    </TooltipProvider>
  );
}
