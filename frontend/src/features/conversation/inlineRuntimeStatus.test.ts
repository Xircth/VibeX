import { describe, expect, it } from 'vitest';
import type {
  ConversationConnectionStatus,
  ConversationError,
  ConversationRequestStatus,
  ConversationSessionNotice,
} from 'shared/types';
import {
  deriveInlineStreamRuntimeStatus,
  parseReconnectProgressTitle,
} from './inlineRuntimeStatus';

const readyConnection = (
  overrides: Partial<ConversationConnectionStatus> = {}
): ConversationConnectionStatus => ({
  status: 'ready',
  bound: true,
  connection_id: 'conn-1',
  message: null,
  since: '2026-11-15T00:00:00Z',
  ...overrides,
});

const requestStatus = (
  phase: ConversationRequestStatus['activity']['phase'],
  overrides: Partial<ConversationRequestStatus> = {}
): ConversationRequestStatus => ({
  turn_id: 'turn-1',
  prompt_id: 'prompt-1',
  connection_id: 'conn-1',
  since: '2026-11-15T00:00:00Z',
  activity: { phase, retry: null },
  ...overrides,
});

const turnError = (
  kind: ConversationError['kind'],
  code: string | null = null
): ConversationError => ({
  message: 'error detail',
  code,
  raw: null,
  kind,
});

describe('deriveInlineStreamRuntimeStatus', () => {
  it('stays silent when connection is ready and bound with no active request', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: null,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('suppresses failed request status when TurnErrorCard already covers the failure', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('failed'),
        latestTurnError: turnError('service_error', 'internal_error'),
        hasLatestTurnErrorRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('suppresses interrupted request status when interrupted-turn notice exists', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('interrupted'),
        hasLatestInterruptedRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('collapses connecting flag, reconnect notice, and connection status into one stream entry during an active user turn', () => {
    const genericReconnect: ConversationSessionNotice = {
      title: '正在连接 Agent…',
      message: null,
      severity: 'info',
    };
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: requestStatus('waiting_agent'),
      reconnectNotice: genericReconnect,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('recovering');
    expect(res.status?.titleOverride).toBeNull();
    expect(res.status?.canCancel).toBe(true);
    expect(res.isConnectionRecovering).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
    expect(res.suppressAssistantStreamingStatus).toBe(true);
  });

  it('routes pre-send connection status to composer placement instead of the message stream', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: null,
      reconnectNotice: {
        title: '会话加载异常，正在重连 3/10 次…',
        message: null,
        severity: 'warning',
      },
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.titleOverride).toBe('会话加载异常，正在重连 3/10 次…');
    expect(res.suppressAssistantStreamingStatus).toBe(false);
  });

  it('routes pre-send initial connecting state to composer even if no reconnectNotice exists yet', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('connecting');
  });

  it('suppresses connection error when TurnErrorCard already reports a connection failure', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection({
          status: 'closed',
          bound: false,
          message: 'socket closed',
        }),
        request: requestStatus('failed'),
        connectErrorNotice: {
          title: '会话出错',
          message: 'socket closed',
          severity: 'error',
        },
        latestTurnError: turnError('connection_closed', 'agent_connection_lost'),
        hasLatestTurnErrorRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      }).status
    ).toBeNull();
  });

  it('shows connection error in composer placement when no turn is in flight', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        message: null,
      }),
      request: null,
      connectErrorNotice: {
        title: 'Agent session recovery failed',
        message: 'transport closed unexpectedly',
        severity: 'error',
      },
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.canReconnect).toBe(true);
    expect(res.status?.notice.connection_status?.message).toBe(
      'transport closed unexpectedly'
    );
  });

  it('keeps connecting status in stream while assistant row has no content yet, then hands off once blocks arrive', () => {
    const beforeAssistantBlocks = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_agent'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });
    expect(beforeAssistantBlocks.placement).toBe('stream');
    expect(beforeAssistantBlocks.status?.kind).toBe('request');
    expect(beforeAssistantBlocks.suppressAssistantStreamingStatus).toBe(true);
    expect(beforeAssistantBlocks.suppressLiveTurnStatsStatus).toBe(true);

    const whileResponding = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('responding'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });
    expect(whileResponding.status).toBeNull();
    expect(whileResponding.placement).toBeNull();
    expect(whileResponding.suppressAssistantStreamingStatus).toBe(false);
    expect(whileResponding.suppressLiveTurnStatsStatus).toBe(false);
  });

  it('surfaces inline retry/cancel status even when an assistant row has content and suppresses duplicate indicators', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('retrying', {
        activity: {
          phase: 'retrying',
          retry: {
            attempt: 2,
            max_attempts: 5,
            delay_ms: 3000n,
            reason: 'rate limited',
            code: null,
          },
        },
      }),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('request');
    expect(res.status?.notice.request_status?.activity.phase).toBe('retrying');
    expect(res.status?.canCancel).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
    expect(res.suppressAssistantStreamingStatus).toBe(true);
  });

  it('ignores leftover non-terminal request state when no turn is in flight', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('thinking'),
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      }).status
    ).toBeNull();
  });

  it('keeps inline retry available if request failed without a TurnErrorCard row', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('failed'),
      latestTurnError: null,
      hasLatestTurnErrorRow: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('request');
    expect(res.status?.canRetry).toBe(true);
  });

  it('keeps post-send cold-start connecting in stream before assistant blocks arrive and hands off once content streams', () => {
    const coldStart = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('waiting_agent'),
      reconnectNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });

    expect(coldStart.placement).toBe('stream');
    expect(coldStart.status?.kind).toBe('connection');
    expect(coldStart.suppressAssistantStreamingStatus).toBe(true);
    expect(coldStart.isConnectionRecovering).toBe(false);

    const streamingContent = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('responding'),
      reconnectNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });

    expect(streamingContent).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('parses retry counts from reconnect progress titles', () => {
    expect(parseReconnectProgressTitle('会话加载异常，正在重连 3/10 次…')).toEqual({
      attempt: 3,
      maxAttempts: 10,
    });
    expect(parseReconnectProgressTitle('Reconnecting 2 / 5...')).toEqual({
      attempt: 2,
      maxAttempts: 5,
    });
    expect(parseReconnectProgressTitle('正在连接 Agent…')).toBeNull();
  });
});

