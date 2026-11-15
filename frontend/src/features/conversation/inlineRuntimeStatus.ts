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
  suppressLiveTurnStatsStatus: boolean;
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
  isTurnInFlight: boolean;
  hasStreamingAssistantRow: boolean;
  hasInteraction?: boolean;
  hasRunningTool?: boolean;
  currentTurnId?: string;
};

export function isConnectionSupersededByTurnError(
  latestTurnError: ConversationError | null | undefined,
  hasLatestTurnErrorRow = Boolean(latestTurnError)
): boolean {
  if (!hasLatestTurnErrorRow || !latestTurnError) return false;
  if (CONNECTION_ERROR_TURN_KINDS.has(latestTurnError.kind)) return true;
  if (latestTurnError.code && CONNECTION_ERROR_TURN_CODES.has(latestTurnError.code)) {
    return true;
  }
  return false;
}

/**
 * Collapses connection & request runtime state into at most ONE inline status
 * item for the message stream, avoiding duplicated "ready", reconnect, and
 * turn-failure banners in the bottom ConversationStatusDock.
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
    hasStreamingAssistantRow,
    hasInteraction = false,
    hasRunningTool = false,
    currentTurnId,
  } = input;

  const connectionFailed =
    connection?.status === 'error' || connection?.status === 'closed';
  const connectionPending =
    connecting ||
    Boolean(reconnectNotice) ||
    (connection != null && !connection.bound && !connectionFailed);
  const isConnectionRecovering =
    Boolean(reconnectNotice) ||
    connection?.status === 'connecting' ||
    connection?.status === 'recovering' ||
    (connecting && !connection?.bound);

  if (connectionPending) {
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
      suppressLiveTurnStatsStatus: hasStreamingAssistantRow,
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
      return {
        status: null,
        suppressLiveTurnStatsStatus: false,
        isConnectionRecovering: false,
      };
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
      suppressLiveTurnStatsStatus: hasStreamingAssistantRow,
      isConnectionRecovering: false,
    };
  }

  // Healthy ready & bound connection should stay silent in the UI.
  if (!request) {
    return {
      status: null,
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    };
  }

  const phase = requestStatusKey({
    request,
    connection,
    hasInteraction,
    hasRunningTool,
    currentTurnId,
  });
  const terminal = isRequestTerminal(phase);

  if (isTurnInFlight) {
    if (terminal) {
      return {
        status: null,
        suppressLiveTurnStatsStatus: false,
        isConnectionRecovering: false,
      };
    }

    // LiveTurnStats renders active request phase when an assistant turn is
    // already streaming, unless retry/cancel needs richer details & actions.
    const shouldRenderInline =
      !hasStreamingAssistantRow || phase === 'retrying' || phase === 'cancelling';

    if (!shouldRenderInline) {
      return {
        status: null,
        suppressLiveTurnStatsStatus: false,
        isConnectionRecovering: false,
      };
    }

    return {
      status: {
        kind: 'request',
        notice: {
          title: 'Agent request',
          severity: 'info',
          request_status: {
            ...request,
            activity: { ...request.activity, phase },
          },
        },
        titleOverride: null,
        canCancel: phase !== 'cancelling',
        canReconnect: false,
        canRetry: false,
      },
      suppressLiveTurnStatsStatus: hasStreamingAssistantRow,
      isConnectionRecovering: false,
    };
  }

  // Ignore non-terminal request leftovers once the turn is no longer in flight.
  if (!terminal || phase === 'completed') {
    return {
      status: null,
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    };
  }

  // TurnErrorCard in ConversationStatusDock already owns failed/cancelled errors.
  if ((phase === 'failed' || phase === 'cancelled') && hasLatestTurnErrorRow) {
    return {
      status: null,
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    };
  }

  // Interrupted-turn notice in ConversationStatusDock already owns restart interruptions.
  if (
    phase === 'interrupted' &&
    (hasLatestInterruptedRow || hasLatestTurnErrorRow)
  ) {
    return {
      status: null,
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    };
  }

  return {
    status: {
      kind: 'request',
      notice: {
        title: 'Agent request',
        severity: phase === 'failed' ? 'error' : 'info',
        request_status: {
          ...request,
          activity: { ...request.activity, phase },
        },
      },
      titleOverride: null,
      canCancel: false,
      canReconnect: false,
      canRetry: true,
    },
    suppressLiveTurnStatsStatus: false,
    isConnectionRecovering: false,
  };
}
