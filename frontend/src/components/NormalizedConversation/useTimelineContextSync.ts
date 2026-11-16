import { useEffect, useMemo } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentElicitationResponse,
  AgentKind,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  DeliveryChannel,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import {
  useOptionalConversationStatus,
  type ConversationStatusNotice,
} from '@/contexts/ConversationStatusContext';
import { useOptionalEntries } from '@/contexts/EntriesContext';
import { publishLiveSessionControls } from '@/features/agents/sessionControlsQuery';
import {
  isDurableHostNote,
  normalizeAgentIdentity,
  type ConversationSessionModesState,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import {
  AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID,
  AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
  AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
  AUTO_PERMISSION_NOTICE_ROW_ID,
  isResendColdStartNotice,
  sessionNoticeNeedsRebind,
} from '@/features/conversation/sessionNoticeNeedsRebind';
import { findMatchingAskQuestionToolInUses } from '@/components/NormalizedConversation/TurnActivity';
import { useConversationRateLimitState } from '@/components/NormalizedConversation/useConversationRateLimitState';
import { mergeQuestionRequestWithToolUse } from '@/components/tasks/follow-up/agentQuestionModel';
import { composerMessageHistoryFromTurns } from '@/components/tasks/follow-up/sessionComposerHistory';
import { getComposerSteeringTarget } from '@/components/tasks/follow-up/sessionComposerSteering';
import { isContextCompactPrompt } from '@/lib/contextCompact';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { deriveInlineStreamRuntimeStatus } from '@/features/conversation/inlineRuntimeStatus';
import type { conversationRuntimeStatus } from '@/features/conversation/runtimeStatus';
import type { TurnStatsData } from './thread/turnStatsModel';
import {
  buildLiveTurnStats,
  getLatestTimelinePlanEntries,
  latestTokenUsage,
  vibexTurnIdFromTimelineRowId,
} from './timelineMemoHelpers';

const EMPTY_TIMELINE_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};
const EMPTY_TIMELINE_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];

type QuestionRow = Extract<TimelineRow['row'], { kind: 'question_request' }>;
type RuntimeStatusSnapshot = ReturnType<typeof conversationRuntimeStatus>;

export function useTimelineContextSync({
  attempt,
  sessionId,
  timeline,
  sideRows,
  sessionBindReady,
  connecting,
  runtimeConnection,
  runtimeRequest,
  controlsAgentId,
  sessionModes,
  sessionConfigOptions,
  steeringSupported,
  currentTurnId,
  deliveryChannel,
  isTurnInFlight,
  askQuestionUses,
  latestTurnError,
  latestTurnErrorRow,
  latestInterruptedRow,
  userOrdinalByKey,
  respondingPermissionId,
  respondingQuestionId,
  handleRespondPermission,
  handleRespondQuestion,
  handleOpenChild,
  handleRetry,
  handleRetryLatestTurn,
  handleCancelRuntimeRequest,
  conversationReconnectAndReload,
  conversationRebindSession,
  searchParams,
  setSearchParams,
}: {
  attempt: WorkspaceWithSession;
  sessionId: string | null;
  timeline: ConversationTimelineTurn[];
  sideRows: TimelineRow[];
  sessionBindReady: boolean;
  connecting: boolean;
  runtimeConnection: RuntimeStatusSnapshot['connection'];
  runtimeRequest: RuntimeStatusSnapshot['request'];
  controlsAgentId: string | null;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
  steeringSupported: boolean;
  currentTurnId: string | null;
  deliveryChannel: DeliveryChannel;
  isTurnInFlight: boolean;
  askQuestionUses: ReturnType<
    typeof import('@/components/NormalizedConversation/TurnActivity').collectAskQuestionToolUses
  >;
  latestTurnError: Extract<
    TimelineRow['row'],
    { kind: 'turn_error' }
  >['error']['error'] | null;
  latestTurnErrorRow: TimelineRow | undefined;
  latestInterruptedRow: ConversationTimelineTurn | null;
  userOrdinalByKey: Map<string, number>;
  respondingPermissionId: string | null;
  respondingQuestionId: string | null;
  handleRespondPermission: (
    permissionId: string,
    response: AgentPermissionResponse
  ) => void;
  handleRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void;
  handleOpenChild: (childConversationId: string) => void;
  handleRetry: (
    turn: MessageTurn,
    ordinal: number,
    replacementText?: string
  ) => Promise<boolean>;
  handleRetryLatestTurn: (() => Promise<boolean>) | undefined;
  handleCancelRuntimeRequest: () => Promise<void>;
  conversationReconnectAndReload: () => Promise<void>;
  conversationRebindSession: () => Promise<void>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
}) {
  const queryClient = useQueryClient();
  const entries = useOptionalEntries();
  const conversationStatus = useOptionalConversationStatus();

  const setConversationStatusNotices = conversationStatus?.setNotices;
  const setSessionBindReady = conversationStatus?.setSessionBindReady;
  const setConversationStatusQuestion = conversationStatus?.setQuestion;
  const setConversationStatusPermissions = conversationStatus?.setPermissions;
  const setConversationChildrenDock = conversationStatus?.setChildrenDock;
  const setConversationStatusRateLimit = conversationStatus?.setRateLimit;
  const usesComposerStatusDock = conversationStatus?.enabled ?? false;

  useEffect(() => {
    setSessionBindReady?.(sessionBindReady);
  }, [sessionBindReady, setSessionBindReady]);

  useEffect(() => {
    if (
      !usesComposerStatusDock ||
      !sessionId ||
      attempt.session?.executor === 'workflow'
    ) {
      setConversationChildrenDock?.(null);
      return;
    }
    setConversationChildrenDock?.({
      conversationId: sessionId,
      onOpenChild: handleOpenChild,
    });
    return () => setConversationChildrenDock?.(null);
  }, [
    attempt.session?.executor,
    handleOpenChild,
    sessionId,
    setConversationChildrenDock,
    usesComposerStatusDock,
  ]);

  const setTokenUsageInfo = entries?.setTokenUsageInfo;
  const composerTokenUsage = useMemo(
    () => latestTokenUsage(timeline),
    [timeline]
  );
  useEffect(() => {
    setTokenUsageInfo?.(composerTokenUsage);
  }, [setTokenUsageInfo, composerTokenUsage]);

  const sessionAgentType = (attempt.session?.agent_id ??
    attempt.session?.executor) as AgentKind | null;
  const normalizedSessionAgent = normalizeAgentIdentity(sessionAgentType);
  const controlsMatchSessionAgent =
    !normalizedSessionAgent ||
    !controlsAgentId ||
    controlsAgentId === normalizedSessionAgent;

  const setSessionModes = entries?.setSessionModes;
  const conversationSessionModes = controlsMatchSessionAgent
    ? sessionModes
    : EMPTY_TIMELINE_SESSION_MODES;
  useEffect(() => {
    setSessionModes?.(conversationSessionModes);
  }, [setSessionModes, conversationSessionModes]);

  const setSessionConfigOptions = entries?.setSessionConfigOptions;
  const conversationSessionConfigOptions = controlsMatchSessionAgent
    ? sessionConfigOptions
    : EMPTY_TIMELINE_CONFIG_OPTIONS;
  useEffect(() => {
    setSessionConfigOptions?.(conversationSessionConfigOptions);
  }, [setSessionConfigOptions, conversationSessionConfigOptions]);

  useEffect(() => {
    if (
      !sessionAgentType ||
      !normalizedSessionAgent ||
      controlsAgentId !== normalizedSessionAgent ||
      (conversationSessionModes.modes.length === 0 &&
        conversationSessionConfigOptions.length === 0)
    ) {
      return;
    }
    publishLiveSessionControls(queryClient, {
      agentType: sessionAgentType,
      workspaceId: attempt.id,
      controls: {
        modes: conversationSessionModes.modes,
        current_mode: conversationSessionModes.current,
        config_options: conversationSessionConfigOptions,
      },
    });
  }, [
    attempt.id,
    controlsAgentId,
    conversationSessionConfigOptions,
    conversationSessionModes,
    normalizedSessionAgent,
    queryClient,
    sessionAgentType,
  ]);

  const setConversationPlanEntries = entries?.setConversationPlanEntries;
  const setConversationTurnInFlight = entries?.setConversationTurnInFlight;
  const setConversationSteeringTurnId = entries?.setConversationSteeringTurnId;
  const setConversationSteeringTarget = entries?.setConversationSteeringTarget;
  const setConversationDeliveryChannel =
    entries?.setConversationDeliveryChannel;

  const conversationPlanEntries = useMemo(
    () => getLatestTimelinePlanEntries(timeline),
    [timeline]
  );
  useEffect(() => {
    setConversationPlanEntries?.(conversationPlanEntries);
  }, [conversationPlanEntries, setConversationPlanEntries]);

  useEffect(() => {
    setConversationTurnInFlight?.(isTurnInFlight);
  }, [isTurnInFlight, setConversationTurnInFlight]);

  useEffect(() => {
    const target = getComposerSteeringTarget({
      isTurnInFlight,
      steeringSupported,
      currentTurnId,
    });
    setConversationSteeringTarget?.(target);
    setConversationSteeringTurnId?.(
      target?.mode === 'native' ? target.turnId : null
    );
  }, [
    currentTurnId,
    isTurnInFlight,
    setConversationSteeringTarget,
    setConversationSteeringTurnId,
    steeringSupported,
  ]);

  useEffect(() => {
    setConversationDeliveryChannel?.(deliveryChannel);
  }, [deliveryChannel, setConversationDeliveryChannel]);

  const setUserMessageHistory = entries?.setUserMessageHistory;
  const timelineTurns = useMemo(
    () => timeline.map((row) => row.turn),
    [timeline]
  );
  const composerUserMessageHistory = useMemo(
    () =>
      composerMessageHistoryFromTurns(timelineTurns, isContextCompactPrompt),
    [timelineTurns]
  );
  useEffect(() => {
    setUserMessageHistory?.(composerUserMessageHistory);
  }, [composerUserMessageHistory, setUserMessageHistory]);

  const liveStats = useMemo<TurnStatsData>(
    () =>
      buildLiveTurnStats({
        timeline,
        sessionConfigOptions: conversationSessionConfigOptions,
      }),
    [conversationSessionConfigOptions, timeline]
  );

  const pendingQuestionRow = useMemo(
    () =>
      sideRows
        .filter(
          (entry) =>
            entry.row.kind === 'question_request' && !entry.row.response
        )
        .at(-1),
    [sideRows]
  );
  const composerQuestion = useMemo(() => {
    if (
      !usesComposerStatusDock ||
      pendingQuestionRow?.row.kind !== 'question_request'
    ) {
      return null;
    }
    const matchedUse = findMatchingAskQuestionToolInUses(
      (pendingQuestionRow.row as QuestionRow).request,
      askQuestionUses
    );
    return {
      request: mergeQuestionRequestWithToolUse(
        (pendingQuestionRow.row as QuestionRow).request,
        matchedUse
      ),
      responding:
        respondingQuestionId ===
        (pendingQuestionRow.row as QuestionRow).request.question_id,
      onRespond: handleRespondQuestion,
    };
  }, [
    askQuestionUses,
    handleRespondQuestion,
    pendingQuestionRow,
    respondingQuestionId,
    usesComposerStatusDock,
  ]);

  const pendingPermissions = useMemo(
    () =>
      sideRows.flatMap((entry) =>
        entry.row.kind === 'permission_request' &&
        entry.row.request.status === 'pending'
          ? [entry.row.request]
          : []
      ),
    [sideRows]
  );

  const sessionNoticeRows = useMemo(
    () =>
      sideRows.filter(
        (entry) =>
          entry.row.kind === 'session_notice' &&
          !entry.row.notice.connection_status &&
          !entry.row.notice.request_status
      ),
    [sideRows]
  );
  const autoPermissionNoticeRow = useMemo(
    () =>
      sessionNoticeRows.find(
        (entry) => entry.row_id === AUTO_PERMISSION_NOTICE_ROW_ID
      ),
    [sessionNoticeRows]
  );
  const reconnectNoticeRow = useMemo(
    () =>
      sessionNoticeRows.find(
        (entry) => entry.row_id === AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID
      ),
    [sessionNoticeRows]
  );
  const connectErrorNoticeRow = useMemo(
    () =>
      sessionNoticeRows.find(
        (entry) => entry.row_id === AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID
      ),
    [sessionNoticeRows]
  );
  const latestSessionNoticeRow = useMemo(() => {
    for (let i = sessionNoticeRows.length - 1; i >= 0; i -= 1) {
      const entry = sessionNoticeRows[i]!;
      if (
        !isDurableHostNote(entry) &&
        entry.row_id !== AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID &&
        entry.row_id !== AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID &&
        entry.row_id !== AUTO_PERMISSION_NOTICE_ROW_ID
      ) {
        return entry;
      }
    }
    return undefined;
  }, [sessionNoticeRows]);

  const hasPendingPermission = pendingPermissions.length > 0;
  const hasUserMessage = useMemo(
    () => timeline.some((turn) => turn.turn.role === 'user'),
    [timeline]
  );
  const streamingAssistantRow = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const turn = timeline[i];
      if (turn?.turn.role === 'assistant' && turn.phase === 'streaming') {
        return turn;
      }
    }
    return null;
  }, [timeline]);
  const hasStreamingAssistantContent = Boolean(
    streamingAssistantRow && streamingAssistantRow.turn.blocks.length > 0
  );
  const hasRunningTool = useMemo(
    () =>
      streamingAssistantRow?.turn.blocks.some(
        (block) =>
          block.type === 'tool_use' &&
          (block.status === 'in_progress' || block.status === 'pending')
      ) ?? false,
    [streamingAssistantRow]
  );
  const inlineRuntimePresentation = useMemo(
    () =>
      deriveInlineStreamRuntimeStatus({
        connecting,
        connection: runtimeConnection,
        request: runtimeRequest,
        reconnectNotice:
          reconnectNoticeRow?.row.kind === 'session_notice'
            ? reconnectNoticeRow.row.notice
            : null,
        connectErrorNotice:
          connectErrorNoticeRow?.row.kind === 'session_notice'
            ? connectErrorNoticeRow.row.notice
            : null,
        latestTurnError,
        hasLatestTurnErrorRow: Boolean(latestTurnErrorRow),
        hasLatestInterruptedRow: Boolean(latestInterruptedRow),
        hasUserMessage,
        isTurnInFlight,
        hasStreamingAssistantRow: Boolean(streamingAssistantRow),
        hasStreamingAssistantContent,
        hasInteraction: Boolean(pendingQuestionRow) || hasPendingPermission,
        hasRunningTool,
        currentTurnId: streamingAssistantRow
          ? vibexTurnIdFromTimelineRowId(streamingAssistantRow.turn.id)
          : (currentTurnId ?? undefined),
      }),
    [
      connectErrorNoticeRow,
      connecting,
      currentTurnId,
      hasPendingPermission,
      hasRunningTool,
      hasStreamingAssistantContent,
      hasUserMessage,
      isTurnInFlight,
      latestInterruptedRow,
      latestTurnError,
      latestTurnErrorRow,
      pendingQuestionRow,
      reconnectNoticeRow,
      runtimeConnection,
      runtimeRequest,
      streamingAssistantRow,
    ]
  );

  const statusNotices = useMemo(() => {
    const notices: ConversationStatusNotice[] = [];
    const pushSessionNotice = (row: TimelineRow | undefined) => {
      if (!row || row.row.kind !== 'session_notice' || !row.row.notice) return;
      if (isResendColdStartNotice(row.row_id, row.row.notice)) return;
      if (notices.some((notice) => notice.id === row.row_id)) return;
      const notice = row.row.notice;
      notices.push({
        id: row.row_id,
        kind: 'session-notice' as const,
        notice,
        onRebind: sessionNoticeNeedsRebind(notice, row.row_id)
          ? conversationRebindSession
          : undefined,
        onReload:
          row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
            ? conversationReconnectAndReload
            : undefined,
        onNewConversation:
          row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
            ? () =>
                requestCreateSessionInExecutionArea(
                  setSearchParams,
                  searchParams
                )
            : undefined,
      });
    };
    if (latestTurnError && latestTurnErrorRow) {
      notices.push({
        id: latestTurnErrorRow.row_id,
        kind: 'turn-error' as const,
        error: latestTurnError,
        onReload: conversationReconnectAndReload,
        onRebind: conversationRebindSession,
        onRetry: handleRetryLatestTurn,
      });
    }
    pushSessionNotice(autoPermissionNoticeRow);
    if (latestInterruptedRow) {
      notices.push({
        id: latestInterruptedRow.key,
        kind: 'interrupted-turn' as const,
        onResend: () =>
          void handleRetry(
            latestInterruptedRow.turn,
            userOrdinalByKey.get(latestInterruptedRow.key) ?? 0
          ),
      });
    }
    if (latestSessionNoticeRow?.row_id !== autoPermissionNoticeRow?.row_id) {
      pushSessionNotice(latestSessionNoticeRow);
    }
    if (
      inlineRuntimePresentation.placement === 'composer' &&
      inlineRuntimePresentation.status
    ) {
      const runtimeItem = inlineRuntimePresentation.status;
      notices.push({
        id: `runtime:${runtimeItem.kind}`,
        kind: 'session-notice' as const,
        notice: runtimeItem.notice,
        titleOverride: runtimeItem.titleOverride,
        onCancel: runtimeItem.canCancel
          ? handleCancelRuntimeRequest
          : undefined,
        onReload: runtimeItem.canReconnect
          ? conversationReconnectAndReload
          : undefined,
        onRetry: runtimeItem.canRetry ? handleRetryLatestTurn : undefined,
      });
    }
    return notices;
  }, [
    autoPermissionNoticeRow,
    conversationReconnectAndReload,
    conversationRebindSession,
    handleCancelRuntimeRequest,
    handleRetry,
    handleRetryLatestTurn,
    inlineRuntimePresentation.placement,
    inlineRuntimePresentation.status,
    latestInterruptedRow,
    latestSessionNoticeRow,
    latestTurnError,
    latestTurnErrorRow,
    searchParams,
    setSearchParams,
    userOrdinalByKey,
  ]);

  useEffect(() => {
    if (!usesComposerStatusDock) {
      setConversationStatusNotices?.([]);
      return;
    }
    setConversationStatusNotices?.(statusNotices);
  }, [setConversationStatusNotices, statusNotices, usesComposerStatusDock]);

  useEffect(() => {
    setConversationStatusQuestion?.(composerQuestion);
    return () => setConversationStatusQuestion?.(null);
  }, [composerQuestion, setConversationStatusQuestion]);

  const composerPermissions = useMemo(() => {
    if (!usesComposerStatusDock) return [];
    return pendingPermissions.map((request) => ({
      request,
      responding: respondingPermissionId === request.permission_id,
      onRespond: handleRespondPermission,
    }));
  }, [
    handleRespondPermission,
    pendingPermissions,
    respondingPermissionId,
    usesComposerStatusDock,
  ]);

  useEffect(() => {
    setConversationStatusPermissions?.(composerPermissions);
    return () => setConversationStatusPermissions?.([]);
  }, [composerPermissions, setConversationStatusPermissions]);

  const {
    rateLimit: activeRateLimitState,
    handleUpdateAutoResume: handleRateLimitAutoResume,
    handleCancelWait: handleRateLimitCancelWait,
  } = useConversationRateLimitState({
    sessionId,
    agentId: attempt.session?.agent_id ?? attempt.session?.executor,
    sessionRecord: attempt.session,
    sideRows,
    latestTurnError,
    latestTurnErrorRowId: latestTurnErrorRow?.row_id ?? null,
  });

  useEffect(() => {
    if (!usesComposerStatusDock || !sessionId || !activeRateLimitState) {
      setConversationStatusRateLimit?.(null);
      return;
    }
    setConversationStatusRateLimit?.({
      conversationId: sessionId,
      state: activeRateLimitState,
      onUpdateAutoResume: handleRateLimitAutoResume,
      onCancelWait: handleRateLimitCancelWait,
    });
    return () => setConversationStatusRateLimit?.(null);
  }, [
    activeRateLimitState,
    handleRateLimitAutoResume,
    handleRateLimitCancelWait,
    sessionId,
    setConversationStatusRateLimit,
    usesComposerStatusDock,
  ]);

  return {
    usesComposerStatusDock,
    conversationSessionConfigOptions,
    timelineTurns,
    liveStats,
    pendingQuestionRow,
    pendingPermissions,
    hasPendingPermission,
    reconnectNoticeRow,
    connectErrorNoticeRow,
    streamingAssistantRow,
    hasStreamingAssistantContent,
    hasRunningTool,
    inlineRuntimePresentation,
    statusNotices,
    activeRateLimitState,
    handleRateLimitAutoResume,
    handleRateLimitCancelWait,
  };
}
