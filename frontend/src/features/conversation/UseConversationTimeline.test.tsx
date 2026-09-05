import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTimeline } from './useConversationTimeline';
import { publishOptimisticConversationTurn } from './optimisticTurnEvents';
import type {
  ConversationRowOp,
  ConversationRowOpBatch,
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

const CONVERSATION_ID = 'conversation-1';

const {
  detailMock,
  ensureSessionControlsMock,
  eventsSinceMock,
  listenMock,
  listeners,
} = vi.hoisted(() => {
  const listeners = [] as Array<(batch: ConversationRowOpBatch) => void>;
  return {
    listeners,
    detailMock: vi.fn(),
    ensureSessionControlsMock: vi.fn(),
    eventsSinceMock: vi.fn(),
    listenMock: vi.fn((handler: (batch: ConversationRowOpBatch) => void) => {
      listeners.push(handler);
      return Promise.resolve(() => {});
    }),
  };
});

vi.mock('./conversationApi', () => ({
  conversationApi: {
    detail: detailMock,
    ensureSessionControls: ensureSessionControlsMock,
    eventsSince: eventsSinceMock,
    timelinePage: vi.fn(),
    cancel: vi.fn(),
    respondPermission: vi.fn(),
  },
}));

vi.mock('./events', () => ({
  listenToConversationEvents: listenMock,
}));

function detail(): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION_ID,
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Conversation',
      title_locked: false,
      status: 'inprogress',
      agent_id: 'codex' as const,
      model: null,
      external_session_id: null,
      message_count: 0n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
    turns: [],
    timeline: {
      conversation_id: CONVERSATION_ID,
      projection_version: 2,
      last_sequence: 0n,
      rows: [],
      truncated_from_start: false,
      older_cursor: null,
    },
    projection_version: 2,
    session_config_options: [],
  };
}

function messageTurn(
  id: string,
  role: 'user' | 'assistant',
  blocks: ContentBlock[]
): MessageTurn {
  return { id, role, blocks, timestamp: '2026-07-03T00:00:00.000Z' };
}

function userRow(turnId: string, text: string, revision: bigint): TimelineRow {
  return {
    row_id: `${turnId}:user`,
    revision,
    row: {
      kind: 'message_turn',
      phase: 'persisted',
      turn: messageTurn(`${turnId}:user`, 'user', [{ type: 'text', text }]),
    },
  };
}

function assistantRow(
  turnId: string,
  text: string,
  revision: bigint
): TimelineRow {
  return {
    row_id: `${turnId}:assistant`,
    revision,
    row: {
      kind: 'message_turn',
      phase: 'settled',
      turn: messageTurn(`${turnId}:assistant`, 'assistant', [
        { type: 'text', text },
      ]),
    },
  };
}

function batch(
  ops: ConversationRowOp[],
  lastSequence: bigint
): ConversationRowOpBatch {
  return {
    conversation_id: CONVERSATION_ID,
    last_sequence: lastSequence,
    ops,
    session_modes: null,
    session_config_options: null,
  };
}

function rowPage(rows: TimelineRow[], lastSequence: bigint) {
  return {
    conversation_id: CONVERSATION_ID,
    after_sequence: 0n,
    last_sequence: lastSequence,
    rows,
  };
}

describe('useConversationTimeline', () => {
  let rafCallbacks: Array<FrameRequestCallback | null> = [];

  const flushFrames = () => {
    const pending = rafCallbacks;
    rafCallbacks = [];
    pending.forEach((cb) => cb?.(0));
  };

  beforeEach(() => {
    listeners.length = 0;
    detailMock.mockReset();
    ensureSessionControlsMock.mockReset();
    ensureSessionControlsMock.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [],
    });
    eventsSinceMock.mockReset();
    // The hook backfills rows once on subscribe; default to "nothing changed".
    eventsSinceMock.mockResolvedValue(rowPage([], 0n));
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (id >= 1 && id <= rafCallbacks.length) rafCallbacks[id - 1] = null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads projected detail and applies row-op batches', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]?.(
        batch(
          [
            { op: 'upsert', row: userRow('t1', 'q', 1n) },
            { op: 'upsert', row: assistantRow('t1', 'hello', 2n) },
          ],
          2n
        )
      );
    });
    act(() => flushFrames());

    await waitFor(() => expect(result.current.timeline).toHaveLength(2));
    expect(result.current.timeline.map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('shows the optimistic user turn and loading row in the same send frame', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      publishOptimisticConversationTurn({
        type: 'add',
        conversationId: CONVERSATION_ID,
        turn: messageTurn('optimistic-1', 'user', [
          { type: 'text', text: 'go' },
        ]),
      });
    });

    expect(result.current.timeline.map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.current.timeline.at(-1)?.phase).toBe('streaming');
  });

  it('does not launch an agent session when opening imported history', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        message_count: 12n,
        status: 'done',
        external_session_id: 'imported-claude-1',
      },
      session_modes: null,
      session_config_options: [],
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ensureSessionControlsMock).not.toHaveBeenCalled();
  });

  it('backfills from the loaded sequence instead of dumping the full timeline', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: { ...detail().summary, message_count: 8n },
      timeline: {
        ...detail().timeline,
        last_sequence: 80n,
        truncated_from_start: true,
        older_cursor: '80',
        rows: [assistantRow('t80', 'tail', 80n)],
      },
    });

    renderHook(() => useConversationTimeline(CONVERSATION_ID));

    await waitFor(() =>
      expect(eventsSinceMock).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        afterSequence: 80,
        limit: 500,
      })
    );
  });

  it('rehydrates controls when an existing Codex conversation has no control events', async () => {
    detailMock.mockResolvedValue(detail());
    ensureSessionControlsMock.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [
        {
          key: 'mode',
          label: 'Mode',
          category: 'mode',
          value: 'agent',
          choices: [
            { value: 'agent', label: 'Agent' },
            { value: 'agent-full-access', label: 'Agent (full access)' },
          ],
        },
      ],
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID)
    );
    await waitFor(() =>
      expect(result.current.sessionConfigOptions).toEqual([
        expect.objectContaining({ key: 'mode', value: 'agent' }),
      ])
    );
  });

  it('reconnects the agent session before reloading without resetting rows', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        message_count: 1n,
      },
      timeline: {
        ...detail().timeline,
        last_sequence: 1n,
        rows: [userRow('t1', 'keep me', 1n)],
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline).toHaveLength(1);
    ensureSessionControlsMock.mockClear();
    detailMock.mockClear();

    await act(async () => {
      await result.current.reconnectAndReload();
    });

    expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(detailMock).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(result.current.timeline).toHaveLength(1);
  });

  it('keeps projected rows visible when reconnecting fails', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: { ...detail().summary, message_count: 1n },
      timeline: {
        ...detail().timeline,
        last_sequence: 1n,
        rows: [userRow('t1', 'still visible', 1n)],
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    ensureSessionControlsMock.mockRejectedValueOnce(
      new Error('ACP connection failed')
    );

    await act(async () => {
      await expect(
        result.current.reconnectAndReload()
      ).resolves.toBeUndefined();
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.error).toBe('ACP connection failed');
  });

  it('hydrates controls for a newly created non-Codex conversation before its first turn', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        agent_id: 'claude_code',
        message_count: 0n,
      },
    });
    ensureSessionControlsMock.mockResolvedValue({
      modes: [
        { id: 'default', label: 'Default', description: null },
        { id: 'plan', label: 'Plan', description: null },
      ],
      current_mode: 'plan',
      config_options: [],
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID)
    );
    await waitFor(() =>
      expect(result.current.sessionModes).toEqual({
        current: 'plan',
        modes: [
          { id: 'default', label: 'Default', description: null },
          { id: 'plan', label: 'Plan', description: null },
        ],
      })
    );
  });

  it('reconciles a zero-message conversation with its authoritative live controls', async () => {
    const projectedFastOption = {
      key: 'fast-mode',
      label: 'Fast mode',
      category: 'model_config',
      value: 'off',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ],
    };
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        message_count: 0n,
      },
      session_config_options: [projectedFastOption],
    });
    ensureSessionControlsMock.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [{ ...projectedFastOption, value: 'on' }],
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID)
    );
    await waitFor(() =>
      expect(result.current.sessionConfigOptions).toEqual([
        expect.objectContaining({ key: 'fast-mode', value: 'on' }),
      ])
    );
  });

  it('backfills changed rows on subscribe', async () => {
    detailMock.mockResolvedValue(detail());
    eventsSinceMock.mockResolvedValue(
      rowPage(
        [userRow('t1', 'sent message', 1n), assistantRow('t1', 'ok', 2n)],
        2n
      )
    );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(eventsSinceMock).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        afterSequence: 0,
        limit: 500,
      })
    );
    await waitFor(() => expect(result.current.timeline).toHaveLength(2));
    expect(result.current.timeline.map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('backfills rows when a live batch skips sequences', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      timeline: {
        ...detail().timeline,
        last_sequence: 1n,
        rows: [userRow('t1', 'q', 1n)],
      },
    });
    eventsSinceMock
      .mockResolvedValueOnce(rowPage([], 1n))
      .mockResolvedValueOnce(
        rowPage([assistantRow('t1', 'hello', 6n)], 6n)
      );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]?.(
        batch(
          [
            {
              op: 'append_text',
              row_id: 't1:assistant',
              revision: 6n,
              stream: 'text',
              delta: 'x',
            },
          ],
          6n
        )
      );
      flushFrames();
    });

    await waitFor(() =>
      expect(eventsSinceMock).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        afterSequence: 1,
        limit: 500,
      })
    );
  });

  it('accumulates streamed text deltas into one assistant bubble', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]?.(
        batch([{ op: 'upsert', row: userRow('t1', 'go', 1n) }], 1n)
      );
      for (let index = 0; index < 24; index += 1) {
        listeners[0]?.(
          batch(
            [
              {
                op: 'append_text',
                row_id: 't1:assistant',
                revision: BigInt(index + 2),
                stream: 'text',
                delta: 'x',
              },
            ],
            BigInt(index + 2)
          )
        );
      }
    });
    act(() => flushFrames());

    expect(result.current.timeline).toHaveLength(2);
    const assistant = result.current.timeline.find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.blocks).toEqual([
      { type: 'text', text: 'x'.repeat(24) },
    ]);
  });

  it('surfaces the Host error envelope message instead of [object Object]', async () => {
    detailMock.mockRejectedValue({
      code: 'bad_request',
      message: 'missing field conversationId',
      retryable: false,
      operation_id: 'op-1',
      details: null,
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('missing field conversationId');
  });

  it('ignores a canceled Host command so tab switches do not toast', async () => {
    let rejectDetail: ((error: unknown) => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectDetail = reject;
        })
    );

    const { result, unmount } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(detailMock).toHaveBeenCalled());
    unmount();
    rejectDetail?.({ message: 'Request cancelled' });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
  });
});
