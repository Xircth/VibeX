import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTransport } from '@/lib/backendTransport';
import { createConversationApi } from './conversationApi';

const call = vi.fn();
const transport: BackendTransport = { environment: 'desktop', call };
const conversationApi = createConversationApi(transport);

describe('conversationApi', () => {
  beforeEach(() => {
    call.mockReset();
  });

  it('creates conversations through the transport-neutral command', async () => {
    call.mockResolvedValue({ id: 'conversation-1' });

    await conversationApi.create({
      workspaceId: 'workspace-1',
      agentId: 'codex',
      title: 'Remote work',
      initialPrompt: 'Draft the plan',
    });

    expect(call).toHaveBeenCalledWith('conversation_create', {
      workspaceId: 'workspace-1',
      agentId: 'codex',
      title: 'Remote work',
      initialPrompt: 'Draft the plan',
    });
  });

  it('starts turns through conversation_start_turn', async () => {
    call.mockResolvedValue({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      status: 'running',
      lastSequence: 1n,
    });

    await conversationApi.startTurn({
      agentId: 'codex',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      text: 'hello',
      workflowRefs: [
        {
          pluginId: 'dimo.office',
          workflowId: 'create-presentation',
        },
      ],
    });

    expect(call).toHaveBeenCalledWith('conversation_start_turn', {
      request: {
        agentId: 'codex',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        text: 'hello',
        images: [],
        workflowRefs: [
          {
            pluginId: 'dimo.office',
            workflowId: 'create-presentation',
          },
        ],
      },
    });
  });

  it('submits and lists durable conversation inputs through application commands', async () => {
    call.mockResolvedValueOnce({ id: 'input-1', status: 'queued' });
    const payload = {
      agentId: 'codex',
      workspaceId: 'workspace-1',
      text: 'follow up',
    } as const;

    await conversationApi.submitInput('conversation-1', payload);

    expect(call).toHaveBeenLastCalledWith('conversation_input_submit', {
      request: { conversationId: 'conversation-1', payload },
    });

    await conversationApi.submitInput('conversation-1', payload, 'op-stable-1');
    expect(call).toHaveBeenLastCalledWith(
      'conversation_input_submit',
      { request: { conversationId: 'conversation-1', payload } },
      { operationId: 'op-stable-1' }
    );

    call.mockResolvedValueOnce([]);
    await conversationApi.listInputs('conversation-1');
    expect(call).toHaveBeenLastCalledWith('conversation_input_list', {
      request: { conversationId: 'conversation-1' },
    });
  });

  it('steers only an explicitly expected active turn', async () => {
    call.mockResolvedValue({ status: 'accepted' });

    await conversationApi.steer({
      conversationId: 'conversation-1',
      expectedTurnId: 'turn-1',
      text: 'Focus on the failing test',
      images: [],
    });

    expect(call).toHaveBeenCalledWith('conversation_steer', {
      request: {
        conversationId: 'conversation-1',
        expectedTurnId: 'turn-1',
        text: 'Focus on the failing test',
        images: [],
      },
    });
  });

  it('mutates durable inputs with explicit optimistic revisions', async () => {
    call.mockResolvedValue({ id: 'input-1', status: 'queued' });
    const payload = {
      agentId: 'codex',
      workspaceId: 'workspace-1',
      text: 'edited',
    } as const;

    await conversationApi.updateInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 1,
      payload,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_update', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 1,
        payload,
      },
    });

    await conversationApi.reorderInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 2,
      sortKey: 2048,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_reorder', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 2,
        sortKey: 2048,
      },
    });

    await conversationApi.cancelInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 3,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_cancel', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 3,
      },
    });
  });

  it('forks from the tail or a named turn with an optional target agent', async () => {
    call.mockResolvedValue({ conversationId: 'child-1' });

    await conversationApi.fork('conversation-1');
    expect(call).toHaveBeenCalledWith('conversation_fork', {
      conversationId: 'conversation-1',
      atTurnId: null,
      targetAgentId: null,
    });

    await conversationApi.fork('conversation-1', 'turn-9', 'codex');
    expect(call).toHaveBeenLastCalledWith('conversation_fork', {
      conversationId: 'conversation-1',
      atTurnId: 'turn-9',
      targetAgentId: 'codex',
    });
  });

  it('loads conversation detail by conversationId', async () => {
    call.mockResolvedValue({ summary: { id: 'conversation-1' } });

    await conversationApi.detail('conversation-1');

    expect(call).toHaveBeenCalledWith('conversation_detail', {
      conversationId: 'conversation-1',
    });
  });

  it('requests durable events by sequence', async () => {
    call.mockResolvedValue({
      conversation_id: 'conversation-1',
      after_sequence: 4n,
      last_sequence: 4n,
      has_more: false,
      events: [],
    });

    await conversationApi.eventsSince({
      conversationId: 'conversation-1',
      afterSequence: 4n,
      limit: 100,
    });

    const [, args] = call.mock.calls[0];
    expect(() => JSON.stringify(args)).not.toThrow();
    expect(call).toHaveBeenCalledWith('conversation_events_since', {
      request: {
        conversationId: 'conversation-1',
        afterSequence: 4,
        limit: 100,
      },
    });
  });

  it('normalizes rowsSince upserts and tombstones and falls back to conversation_events_since when unimplemented', async () => {
    call.mockResolvedValueOnce({
      conversation_id: 'conversation-1',
      after_sequence: 4n,
      last_sequence: 7n,
      reset: false,
      rows: [
        {
          row_id: 't1:assistant',
          revision: 6n,
          row: {
            kind: 'message_turn',
            phase: 'settled',
            turn: {
              id: 't1:assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'ok' }],
              timestamp: '2026-07-03T00:00:00.000Z',
            },
          },
        },
      ],
      deleted_rows: [{ row_id: 'perm:p1', revision: 7n }],
    });

    const primary = await conversationApi.rowsSince({
      conversationId: 'conversation-1',
      afterSequence: 4n,
    });
    expect(call).toHaveBeenCalledWith('conversation_rows_since', {
      request: {
        conversationId: 'conversation-1',
        afterSequence: 4,
      },
    });
    expect(primary.lastSequence).toBe(7n);
    expect(primary.reset).toBe(false);
    expect(primary.ops).toEqual([
      expect.objectContaining({ op: 'upsert' }),
      { op: 'delete', row_id: 'perm:p1', revision: 7n },
    ]);

    call.mockRejectedValueOnce(
      new Error('404: unknown command conversation_rows_since')
    );
    call.mockResolvedValueOnce({
      conversation_id: 'conversation-1',
      after_sequence: 7n,
      last_sequence: 9n,
      rows: [],
      deleted_row_ids: ['q:1'],
    });
    const fallback = await conversationApi.rowsSince({
      conversationId: 'conversation-1',
      afterSequence: 7n,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_events_since', {
      request: {
        conversationId: 'conversation-1',
        afterSequence: 7,
      },
    });
    expect(fallback.ops).toEqual([
      { op: 'delete', row_id: 'q:1', revision: 9n },
    ]);
  });

  it('forwards opaque keyset cursors verbatim in timelinePage', async () => {
    call.mockResolvedValueOnce({
      conversation_id: 'conversation-1',
      projection_version: 2,
      cursor: 'eyJzb3J0X2luZGV4IjoxMjB9',
      next_cursor: 'eyJzb3J0X2luZGV4Ijo2MH0',
      rows: [],
    });

    await conversationApi.timelinePage({
      conversationId: 'conversation-1',
      cursor: 'eyJzb3J0X2luZGV4IjoxMjB9',
      limit: 120,
    });

    expect(call).toHaveBeenLastCalledWith('conversation_timeline_page', {
      request: {
        conversationId: 'conversation-1',
        cursor: 'eyJzb3J0X2luZGV4IjoxMjB9',
        limit: 120,
      },
    });
  });

  it('normalizes rollback safety reports and falls back gracefully when unimplemented', async () => {
    call.mockResolvedValueOnce({
      Degraded: { reason: 'ACP session does not support revert' },
    });
    await expect(
      conversationApi.checkRollbackSafety({
        conversationId: 'conversation-1',
        ordinal: 2,
      })
    ).resolves.toEqual({
      status: 'degraded',
      reason: 'ACP session does not support revert',
    });

    call.mockResolvedValueOnce({
      status: 'Unsafe',
      reason: 'Another active thread is using this workspace',
    });
    await expect(
      conversationApi.checkRollbackSafety({
        conversationId: 'conversation-1',
        ordinal: 2,
      })
    ).resolves.toEqual({
      status: 'unsafe',
      reason: 'Another active thread is using this workspace',
    });

    call.mockRejectedValueOnce(
      new Error('404: unknown command conversation_check_rollback_safety')
    );
    await expect(
      conversationApi.checkRollbackSafety({
        conversationId: 'conversation-1',
        ordinal: 2,
      })
    ).resolves.toEqual({
      status: 'safe',
      engineSupportsRevert: true,
    });
  });

  it('dispatches rate-limit recovery and engine handoff commands', async () => {
    call.mockResolvedValue(undefined);

    await conversationApi.updateRateLimitAutoResume({
      conversationId: 'conversation-1',
      autoResume: false,
      continuationPrompt: 'Resume tests.',
    });
    expect(call).toHaveBeenLastCalledWith(
      'conversation_rate_limit_update_auto_resume',
      {
        request: {
          conversationId: 'conversation-1',
          autoResume: false,
          continuationPrompt: 'Resume tests.',
        },
      }
    );

    await conversationApi.cancelRateLimitWait({
      conversationId: 'conversation-1',
    });
    expect(call).toHaveBeenLastCalledWith(
      'conversation_rate_limit_cancel_wait',
      {
        request: { conversationId: 'conversation-1' },
      }
    );

    await conversationApi.confirmEngineHandoff({
      conversationId: 'conversation-1',
      targetEngine: 'codex',
    });
    expect(call).toHaveBeenLastCalledWith(
      'conversation_confirm_engine_handoff',
      {
        request: {
          conversationId: 'conversation-1',
          targetEngine: 'codex',
        },
      }
    );
  });
});
