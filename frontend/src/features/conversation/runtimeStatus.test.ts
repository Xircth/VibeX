import { describe, expect, it } from 'vitest';
import { requestStatusKey, waitingAdvisory } from './runtimeStatus';
import type { ConversationRequestStatus, TimelineRow } from 'shared/types';
import { conversationRuntimeStatus } from './runtimeStatus';
const request = (
  phase: ConversationRequestStatus['activity']['phase']
): ConversationRequestStatus => ({
  turn_id: 'turn-1',
  prompt_id: 'prompt-1',
  connection_id: 'conn-1',
  activity: { phase, retry: null },
  since: '2026-11-13T00:00:00Z',
});
describe('request status facts', () => {
  it('does not carry an old terminal state onto a newly submitted turn', () => {
    expect(
      requestStatusKey({
        request: request('failed'),
        connection: null,
        currentTurnId: 'turn-2',
      })
    ).toBe('submitting');
  });
  it('never assumes generation from an in-flight turn or healthy transport', () => {
    expect(requestStatusKey({ request: null, connection: null })).toBe(
      'waiting_agent'
    );
    expect(
      requestStatusKey({
        request: request('waiting_agent'),
        connection: {
          status: 'ready',
          bound: true,
          connection_id: 'c',
          message: null,
          since: '2026-11-13T00:00:00Z',
        },
      })
    ).toBe('waiting_agent');
  });
  it('does not present previous output as ongoing while its connection recovers', () => {
    expect(
      requestStatusKey({
        request: request('responding'),
        connection: {
          status: 'recovering',
          bound: false,
          connection_id: 'conn-1',
          message: null,
          since: request('responding').since,
        },
      })
    ).toBe('waiting_agent');
  });
  it('prioritizes concurrent user and tool blockers while preserving cancel/terminal', () => {
    expect(
      requestStatusKey({
        request: request('responding'),
        connection: null,
        hasInteraction: true,
        hasRunningTool: true,
      })
    ).toBe('waiting_user');
    expect(
      requestStatusKey({
        request: request('thinking'),
        connection: null,
        hasRunningTool: true,
      })
    ).toBe('executing_tool');
    expect(
      requestStatusKey({
        request: request('cancelling'),
        connection: null,
        hasInteraction: true,
      })
    ).toBe('cancelling');
    expect(
      requestStatusKey({
        request: request('failed'),
        connection: null,
        hasRunningTool: true,
      })
    ).toBe('failed');
  });
  it('advises about slow response without timing out tools, user waits or retry backoff', () => {
    const now = Date.parse('2026-11-13T00:01:00Z');
    expect(
      waitingAdvisory('waiting_agent', request('waiting_agent').since, now)
    ).toBe(60);
    for (const phase of [
      'executing_tool',
      'waiting_user',
      'retrying',
      'cancelling',
      'completed',
    ] as const) {
      expect(waitingAdvisory(phase, request(phase).since, now)).toBeNull();
    }
  });
  it('rehydrates both dimensions from the same persisted side rows', () => {
    const connection = {
      status: 'ready' as const,
      bound: true,
      connection_id: 'c',
      message: null,
      since: '2026-11-13T00:00:00Z',
    };
    const rows: TimelineRow[] = [
      {
        row_id: 'status:agent-connection',
        revision: 1n,
        row: {
          kind: 'session_notice',
          notice: {
            title: 'Agent connection',
            severity: 'info',
            connection_status: connection,
          },
        },
      },
      {
        row_id: 'status:agent-request',
        revision: 2n,
        row: {
          kind: 'session_notice',
          notice: {
            title: 'Agent request',
            severity: 'info',
            request_status: request('retrying'),
          },
        },
      },
    ];
    expect(conversationRuntimeStatus(rows)).toEqual({
      connection,
      request: request('retrying'),
    });
  });
});
