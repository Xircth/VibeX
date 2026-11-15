import { describe, expect, it } from 'vitest';
import type {
  ConversationConnectionStatus,
  ConversationError,
  ConversationRequestStatus,
  ConversationSessionNotice,
} from 'shared/types';
import { deriveInlineStreamRuntimeStatus } from './inlineRuntimeStatus';

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
      suppressLiveTurnStatsStatus: false,
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
      suppressLiveTurnStatsStatus: false,
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
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('collapses connecting flag, reconnect notice, and connection status into one stream entry', () => {
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
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
    });

    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('recovering');
    expect(res.status?.titleOverride).toBeNull();
    expect(res.status?.canCancel).toBe(true);
    expect(res.isConnectionRecovering).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
  });

  it('preserves detailed reconnect attempt progress titles', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: null,
      reconnectNotice: {
        title: '会话加载异常，正在重连 3/10 次…',
        message: null,
        severity: 'warning',
      },
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.status?.kind).toBe('connection');
    expect(res.status?.titleOverride).toBe('会话加载异常，正在重连 3/10 次…');
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

  it('shows one inline connection error with reconnect when no connection TurnErrorCard is visible', () => {
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
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.status?.kind).toBe('connection');
    expect(res.status?.canReconnect).toBe(true);
    expect(res.status?.notice.connection_status?.message).toBe(
      'transport closed unexpectedly'
    );
  });

  it('shows active request inline before an assistant turn starts streaming, then hands off to LiveTurnStats', () => {
    const beforeAssistant = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_agent'),
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
    });
    expect(beforeAssistant.status?.kind).toBe('request');
    expect(beforeAssistant.status?.canCancel).toBe(true);

    const whileResponding = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('responding'),
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
    });
    expect(whileResponding.status).toBeNull();
    expect(whileResponding.suppressLiveTurnStatsStatus).toBe(false);
  });

  it('surfaces inline retry/cancel status even when an assistant row exists and suppresses duplicate LiveTurnStats label', () => {
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
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
    });

    expect(res.status?.kind).toBe('request');
    expect(res.status?.notice.request_status?.activity.phase).toBe('retrying');
    expect(res.status?.canCancel).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
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

    expect(res.status?.kind).toBe('request');
    expect(res.status?.canRetry).toBe(true);
  });

  it('hands off initial cold-start connecting turn to LiveTurnStats without marking connection as recovering', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('waiting_agent'),
      reconnectNotice: null,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
    });

    expect(res).toEqual({
      status: null,
      suppressLiveTurnStatsStatus: false,
      isConnectionRecovering: false,
    });
  });
});

