import type {
  ConversationConnectionStatus,
  ConversationError,
  ConversationRequestStatus,
  ConversationSessionNotice,
} from 'shared/types';
import { isRequestTerminal, requestStatusKey } from './runtimeStatus';

const CONNECTION_ERROR_TURN_KINDS = new Set<ConversationError['kind']>([
  'connection_closed',
  'idle_timeout',
  'session_load_failed',
  'resource_not_found',
  'session_resume_unsupported',
  'auth_required',
]);

const CONNECTION_ERROR_TURN_CODES = new Set<string>([
  'connection_closed',
  'agent_connection_lost',
  'idle_timeout',
  'session_load_failed',
  'resource_not_found',
  'session_resume_unsupported',
  'auth_required',
]);

const GENERIC_BACKEND_CONNECTING_TITLE = '正在连接 Agent…';

export type RuntimeStatusPlacement = 'composer' | 'stream';

export type InlineStreamRuntimeStatus = {
  kind: 'connection' | 'request';
  notice: ConversationSessionNotice;
  titleOverride: string | null;
  canCancel: boolean;
  canReconnect: boolean;
  canRetry: boolean;
};

export type InlineStreamRuntimePresentation = {
  status: InlineStreamRuntimeStatus | null;
  placement: RuntimeStatusPlacement | null;
  suppressLiveTurnStatsStatus: boolean;
  suppressAssistantStreamingStatus: boolean;
  isConnectionRecovering: boolean;
};

export type DeriveInlineStreamRuntimeStatusInput = {
  connecting: boolean;
  connection: ConversationConnectionStatus | null;
  request: ConversationRequestStatus | null;
  reconnectNotice?: ConversationSessionNotice | null;
  connectErrorNotice?: ConversationSessionNotice | null;
  latestTurnError?: ConversationError | null;
  hasLatestTurnErrorRow?: boolean;
  hasLatestInterruptedRow?: boolean;
  hasUserMessage?: boolean;
  isTurnInFlight: boolean;
  hasStreamingAssistantRow: boolean;
  hasStreamingAssistantContent?: boolean;
  hasInteraction?: boolean;
  hasRunningTool?: boolean;
  currentTurnId?: string;
};

const SILENT_PRESENTATION: InlineStreamRuntimePresentation = {
  status: null,
  placement: null,
  suppressLiveTurnStatsStatus: false,
  suppressAssistantStreamingStatus: false,
  isConnectionRecovering: false,
};

export function parseReconnectProgressTitle(
  title?: string | null
): { attempt: number; maxAttempts: number } | null {
  if (!title) return null;
  const match = title.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) return null;
  return { attempt, maxAttempts };
}

export function isConnectionSupersededByTurnError(
  latestTurnError: ConversationError | null | undefined,
  hasLatestTurnErrorRow = Boolean(latestTurnError)
): boolean {
  if (!hasLatestTurnErrorRow || !latestTurnError) return false;
  if (CONNECTION_ERROR_TURN_KINDS.has(latestTurnError.kind)) return true;
  if (
    latestTurnError.code &&
    CONNECTION_ERROR_TURN_CODES.has(latestTurnError.code)
  ) {
    return true;
  }
  return false;
}

/**
 * Collapses connection & request runtime state into at most ONE runtime status
 * item and decides whether it belongs above the composer (pre-send / idle
 * connection state) or inline inside the message stream (post-send request).
 */
export function deriveInlineStreamRuntimeStatus(
  input: DeriveInlineStreamRuntimeStatusInput
): InlineStreamRuntimePresentation {
  const {
    connecting,
    connection,
    request,
    reconnectNotice,
    connectErrorNotice,
    latestTurnError,
    hasLatestTurnErrorRow = Boolean(latestTurnError),
    hasLatestInterruptedRow = false,
    isTurnInFlight,
    hasUserMessage = isTurnInFlight,
    hasStreamingAssistantRow,
    hasStreamingAssistantContent = false,
    hasInteraction = false,
    hasRunningTool = false,
    currentTurnId,
  } = input;

  const connectionPlacement: RuntimeStatusPlacement =
    !hasUserMessage || !isTurnInFlight ? 'composer' : 'stream';

  const connectionFailed =
    connection?.status === 'error' || connection?.status === 'closed';
  const connectionPending =
    connecting ||
    Boolean(reconnectNotice) ||
    (connection != null && !connection.bound && !connectionFailed);
  const isConnectionRecovering =
    Boolean(reconnectNotice) || connection?.status === 'recovering';

  if (connectionPending) {
    if (hasStreamingAssistantContent && !isConnectionRecovering) {
      return SILENT_PRESENTATION;
    }

    const resolvedConnection: ConversationConnectionStatus =
      connection && !connectionFailed && !connection.bound
        ? connection
        : {
            status: reconnectNotice ? 'recovering' : 'connecting',
            bound: false,
            connection_id: connection?.connection_id ?? null,
            message: connection?.message ?? reconnectNotice?.message ?? null,
            since: connection?.since ?? '',
          };
    const titleOverride =
      reconnectNotice?.title &&
      reconnectNotice.title !== GENERIC_BACKEND_CONNECTING_TITLE
        ? reconnectNotice.title
        : null;

    return {
      status: {
        kind: 'connection',
        notice: {
          title: 'Agent connection',
          message: resolvedConnection.message,
          severity: reconnectNotice?.severity ?? 'info',
          connection_status: resolvedConnection,
        },
        titleOverride,
        canCancel: ['ready', 'connecting', 'recovering'].includes(
          resolvedConnection.status
        ),
        canReconnect: false,
        canRetry: false,
      },
      placement: connectionPlacement,
      suppressLiveTurnStatsStatus:
        connectionPlacement === 'stream' && hasStreamingAssistantRow,
      suppressAssistantStreamingStatus: connectionPlacement === 'stream',
      isConnectionRecovering,
    };
  }

  if (connectionFailed || connectErrorNotice) {
    const turnErrorCoversConnectNotice =
      !isTurnInFlight && hasLatestTurnErrorRow && Boolean(latestTurnError);
    const turnErrorCoversConnectionLoss =
      turnErrorCoversConnectNotice &&
      isConnectionSupersededByTurnError(latestTurnError, hasLatestTurnErrorRow);

    if (
      turnErrorCoversConnectionLoss ||
      (turnErrorCoversConnectNotice && !connectionFailed)
    ) {
      return SILENT_PRESENTATION;
    }

    const resolvedConnection: ConversationConnectionStatus = connectionFailed
      ? {
          ...connection!,
          message: connection!.message ?? connectErrorNotice?.message ?? null,
        }
      : {
          status: 'error',
          bound: false,
          connection_id: connection?.connection_id ?? null,
          message: connectErrorNotice?.message ?? null,
          since: connection?.since ?? '',
        };

    return {
      status: {
        kind: 'connection',
        notice: {
          title: 'Agent connection',
          message: resolvedConnection.message,
          severity: 'error',
          connection_status: resolvedConnection,
        },
        titleOverride: null,
        canCancel: false,
        canReconnect: true,
        canRetry: false,
      },
      placement: connectionPlacement,
      suppressLiveTurnStatsStatus:
        connectionPlacement === 'stream' && hasStreamingAssistantRow,
      suppressAssistantStreamingStatus:
        connectionPlacement === 'stream' && hasStreamingAssistantRow,
      isConnectionRecovering: false,
    };
  }

  // Healthy ready & bound connection should stay silent in the UI unless a
  // turn is in flight or a post-turn request failure needs inline retry.
  const effectiveRequest: ConversationRequestStatus | null =
    request ??
    (isTurnInFlight &&
    hasUserMessage &&
    !hasStreamingAssistantContent &&
    !hasLatestTurnErrorRow
      ? {
          turn_id: currentTurnId ?? '',
          prompt_id: null,
          connection_id: connection?.connection_id ?? null,
          since: '',
          activity: { phase: 'submitting', retry: null },
        }
      : null);

  if (!effectiveRequest) {
    return SILENT_PRESENTATION;
  }

  const phase = requestStatusKey({
    request: effectiveRequest,
    connection,
    hasInteraction,
    hasRunningTool,
    currentTurnId,
  });
  const terminal = isRequestTerminal(phase);

  if (isTurnInFlight) {
    if (terminal) {
      return SILENT_PRESENTATION;
    }

    // Before the assistant produces any content/thinking/tool block, keep the
    // lightweight connecting status inline instead of showing generation Loading.
    const preGenerationPhase =
      phase === 'submitting' ||
      phase === 'waiting_agent' ||
      phase === 'waiting_model';
    const shouldRenderInline =
      !hasStreamingAssistantRow ||
      (!hasStreamingAssistantContent && preGenerationPhase) ||
      phase === 'retrying' ||
      phase === 'cancelling';

    if (!shouldRenderInline) {
      return SILENT_PRESENTATION;
    }

    return {
      status: {
        kind: 'request',
        notice: {
          title: 'Agent request',
          severity: 'info',
          request_status: {
            ...effectiveRequest,
            activity: { ...effectiveRequest.activity, phase },
          },
        },
        titleOverride: null,
        canCancel: phase !== 'cancelling',
        canReconnect: false,
        canRetry: false,
      },
      placement: 'stream',
      suppressLiveTurnStatsStatus: hasStreamingAssistantRow,
      suppressAssistantStreamingStatus:
        !hasStreamingAssistantContent ||
        phase === 'retrying' ||
        phase === 'cancelling',
      isConnectionRecovering: false,
    };
  }

  // Ignore non-terminal request leftovers once the turn is no longer in flight.
  if (!terminal || phase === 'completed') {
    return SILENT_PRESENTATION;
  }

  // TurnErrorCard in ConversationStatusDock already owns failed/cancelled errors.
  if ((phase === 'failed' || phase === 'cancelled') && hasLatestTurnErrorRow) {
    return SILENT_PRESENTATION;
  }

  // Interrupted-turn notice in ConversationStatusDock already owns restart interruptions.
  if (
    phase === 'interrupted' &&
    (hasLatestInterruptedRow || hasLatestTurnErrorRow)
  ) {
    return SILENT_PRESENTATION;
  }

  return {
    status: {
      kind: 'request',
      notice: {
        title: 'Agent request',
        severity: phase === 'failed' ? 'error' : 'info',
        request_status: {
          ...effectiveRequest,
          activity: { ...effectiveRequest.activity, phase },
        },
      },
      titleOverride: null,
      canCancel: false,
      canReconnect: false,
      canRetry: true,
    },
    placement: 'stream',
    suppressLiveTurnStatsStatus: false,
    suppressAssistantStreamingStatus: false,
    isConnectionRecovering: false,
  };
}
