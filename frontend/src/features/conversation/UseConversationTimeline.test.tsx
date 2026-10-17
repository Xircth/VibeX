import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTimeline } from './useConversationTimeline';
import { resetConversationTimelineRegistryForTests } from './conversationTimelineRegistry';
import { TIMELINE_OLDER_PAGE_SIZE } from './timelinePaging';
import { resetConversationKeepaliveForTests } from './conversationKeepalive';
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
  touchMock,
  eventsSinceMock,
  timelinePageMock,
  listenMock,
  listenToAgentEventsMock,
  listeners,
  agentEventListeners,
} = vi.hoisted(() => {
  const listeners = [] as Array<(batch: ConversationRowOpBatch) => void>;
  const agentEventListeners = [] as Array<
    (envelope: {
      session_id?: string | null;
      event: { kind: string; acp_session_id?: string };
    }) => void
  >;
  return {
    listeners,
    agentEventListeners,
    detailMock: vi.fn(),
    ensureSessionControlsMock: vi.fn(),
    touchMock: vi.fn(),
    eventsSinceMock: vi.fn(),
    timelinePageMock: vi.fn(),
    listenMock: vi.fn((handler: (batch: ConversationRowOpBatch) => void) => {
      listeners.push(handler);
      return Promise.resolve(() => {});
    }),
    listenToAgentEventsMock: vi.fn(
      (
        handler: (envelope: {
          session_id?: string | null;
          event: { kind: string; acp_session_id?: string };
        }) => void
      ) => {
        agentEventListeners.push(handler);
        return Promise.resolve(() => {});
      }
    ),
  };
});

vi.mock('./conversationApi', () => ({
  conversationApi: {
    detail: detailMock,
    ensureSessionControls: ensureSessionControlsMock,
    touch: touchMock,
    eventsSince: eventsSinceMock,
    timelinePage: timelinePageMock,
    cancel: vi.fn(),
    respondPermission: vi.fn(),
  },
}));

vi.mock('./events', () => ({
  listenToConversationEvents: listenMock,
}));

vi.mock('@/features/agents/events', () => ({
  listenToAgentEvents: listenToAgentEventsMock,
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
    resetConversationTimelineRegistryForTests();
    resetConversationKeepaliveForTests();
    listeners.length = 0;
    agentEventListeners.length = 0;
    detailMock.mockReset();
    ensureSessionControlsMock.mockReset();
    ensureSessionControlsMock.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [],
    });
    touchMock.mockReset();
    touchMock.mockResolvedValue({ ok: true, idleTimeoutSecs: 180 });
    eventsSinceMock.mockReset();
    eventsSinceMock.mockResolvedValue(rowPage([], 0n));
    timelinePageMock.mockReset();
    timelinePageMock.mockResolvedValue({
      conversation_id: CONVERSATION_ID,
      projection_version: 2,
      cursor: null,
      next_cursor: null,
      rows: [],
    });
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

  it('drops the previous conversation when the session id changes', async () => {
    detailMock.mockImplementation(async (id: string) => ({
      ...detail(),
      summary: { ...detail().summary, id },
    }));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useConversationTimeline(id),
      { initialProps: { id: CONVERSATION_ID } }
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

    rerender({ id: 'conversation-2' });
    await waitFor(() =>
      expect(detailMock).toHaveBeenCalledWith('conversation-2', undefined)
    );
    await waitFor(() => expect(result.current.timeline).toHaveLength(0));

    rerender({ id: CONVERSATION_ID });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline).toHaveLength(0);
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

  it('connects with the stored session after imported history detail succeeds', async () => {
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
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
  });

  it('shows each older page when the user asks for it', async () => {
    let resolveFirst: (value: {
      conversation_id: string;
      projection_version: number;
      cursor: string | null;
      next_cursor: string | null;
      rows: TimelineRow[];
    }) => void = () => {};
    let resolveSecond: typeof resolveFirst = () => {};
    timelinePageMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    detailMock.mockResolvedValue({
      ...detail(),
      summary: { ...detail().summary, message_count: 8n },
      timeline: {
        ...detail().timeline,
        last_sequence: 80n,
        truncated_from_start: true,
        older_cursor: String(TIMELINE_OLDER_PAGE_SIZE * 2),
        rows: [assistantRow('t-tail', 'latest', 80n)],
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
      't-tail:assistant',
    ]);
    expect(timelinePageMock).not.toHaveBeenCalled();

    let firstPage: Promise<void> = Promise.resolve();
    act(() => {
      firstPage = result.current.loadOlder();
    });
    await waitFor(() => expect(timelinePageMock).toHaveBeenCalledTimes(1));
    expect(timelinePageMock).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      cursor: String(TIMELINE_OLDER_PAGE_SIZE),
      limit: TIMELINE_OLDER_PAGE_SIZE,
    });

    await act(async () => {
      resolveFirst({
        conversation_id: CONVERSATION_ID,
        projection_version: 2,
        cursor: String(TIMELINE_OLDER_PAGE_SIZE),
        next_cursor: String(TIMELINE_OLDER_PAGE_SIZE),
        rows: [userRow('t-mid', 'earlier', 40n)],
      });
      await firstPage;
    });

    await waitFor(() =>
      expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
        't-mid:user',
        't-tail:assistant',
      ])
    );
    expect(timelinePageMock).toHaveBeenCalledTimes(1);
    expect(
      result.current.timeline.some((row) => row.turn.id === 't-early:user')
    ).toBe(false);

    let secondPage: Promise<void> = Promise.resolve();
    act(() => {
      secondPage = result.current.loadOlder();
    });
    await waitFor(() => expect(timelinePageMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond({
        conversation_id: CONVERSATION_ID,
        projection_version: 2,
        cursor: '0',
        next_cursor: null,
        rows: [userRow('t-early', 'first', 1n)],
      });
    });

    await waitFor(() =>
      expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
        't-early:user',
        't-mid:user',
        't-tail:assistant',
      ])
    );
  });

  it('shares one request when loadOlder overlaps an in-flight page', async () => {
    let resolveFirst: (value: {
      conversation_id: string;
      projection_version: number;
      cursor: string | null;
      next_cursor: string | null;
      rows: TimelineRow[];
    }) => void = () => {};
    timelinePageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    detailMock.mockResolvedValue({
      ...detail(),
      summary: { ...detail().summary, message_count: 8n },
      timeline: {
        ...detail().timeline,
        last_sequence: 80n,
        truncated_from_start: true,
        older_cursor: String(TIMELINE_OLDER_PAGE_SIZE * 2),
        rows: [assistantRow('t-tail', 'latest', 80n)],
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    let firstPage: Promise<void> = Promise.resolve();
    act(() => {
      firstPage = result.current.loadOlder();
      void result.current.loadOlder();
    });
    await waitFor(() => expect(timelinePageMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveFirst({
        conversation_id: CONVERSATION_ID,
        projection_version: 2,
        cursor: String(TIMELINE_OLDER_PAGE_SIZE),
        next_cursor: String(TIMELINE_OLDER_PAGE_SIZE),
        rows: [userRow('t-mid', 'earlier', 40n)],
      });
      await firstPage;
    });

    expect(timelinePageMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
        't-mid:user',
        't-tail:assistant',
      ])
    );
  });

  it('refreshes from the loaded window start instead of the open tail', async () => {
    timelinePageMock.mockResolvedValueOnce({
      conversation_id: CONVERSATION_ID,
      projection_version: 2,
      cursor: '0',
      next_cursor: null,
      rows: [
        userRow('t-early', 'first', 1n),
        userRow('t-mid', 'earlier', 40n),
      ],
    });

    const openDetail = {
      ...detail(),
      summary: { ...detail().summary, message_count: 8n },
      timeline: {
        ...detail().timeline,
        last_sequence: 80n,
        truncated_from_start: true,
        older_cursor: String(TIMELINE_OLDER_PAGE_SIZE),
        rows: [assistantRow('t-tail', 'latest', 80n)],
      },
    };
    const fullDetail = {
      ...openDetail,
      timeline: {
        ...openDetail.timeline,
        truncated_from_start: false,
        older_cursor: null,
        rows: [
          userRow('t-early', 'first', 1n),
          userRow('t-mid', 'earlier', 40n),
          assistantRow('t-tail', 'latest', 80n),
        ],
      },
    };
    detailMock.mockImplementation(
      async (_conversationId: string, window?: { fromIndex?: number }) =>
        window?.fromIndex === 0 ? fullDetail : openDetail
    );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.loadOlder();
    });
    await waitFor(() =>
      expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
        't-early:user',
        't-mid:user',
        't-tail:assistant',
      ])
    );

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(2));
    expect(detailMock).toHaveBeenLastCalledWith(CONVERSATION_ID, {
      fromIndex: 0,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline.map((row) => row.turn.id)).toEqual([
      't-early:user',
      't-mid:user',
      't-tail:assistant',
    ]);
  });

  it('does not backfill the event log after the file window loads', async () => {
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

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(eventsSinceMock).not.toHaveBeenCalled();
  });

  it('does not load or connect an inactive conversation surface', async () => {
    detailMock.mockResolvedValue(detail());

    renderHook(() =>
      useConversationTimeline(CONVERSATION_ID, { active: false })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(detailMock).not.toHaveBeenCalled();
    expect(ensureSessionControlsMock).not.toHaveBeenCalled();
    expect(touchMock).not.toHaveBeenCalled();
  });

  it('shares one detail load across panels of the same conversation', async () => {
    detailMock.mockResolvedValue(detail());

    renderHook(() => useConversationTimeline(CONVERSATION_ID));
    renderHook(() => useConversationTimeline(CONVERSATION_ID));

    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(1));
  });

  it('does not connect while conversation detail is still loading', async () => {
    let resolveDetail: (value: DbConversationDetail) => void = () => {};
    detailMock.mockReturnValue(
      new Promise<DbConversationDetail>((resolve) => {
        resolveDetail = resolve;
      })
    );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    expect(result.current.loading).toBe(true);
    expect(ensureSessionControlsMock).not.toHaveBeenCalled();

    resolveDetail(detail());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
  });

  it('auto-connects after opening a conversation with no turns', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
  });

  it('auto-connects a new session that has a workspace but no agent_id yet', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        agent_id: null,
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
    await waitFor(() =>
      expect(touchMock).toHaveBeenCalledWith(CONVERSATION_ID, true)
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

    expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
      reload: true,
    });
    expect(detailMock).toHaveBeenCalledWith(CONVERSATION_ID, {
      fromIndex: 0,
    });
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

  it('auto-connects a newly created conversation before its first turn', async () => {
    detailMock.mockResolvedValue({
      ...detail(),
      summary: {
        ...detail().summary,
        agent_id: 'claude_code',
        message_count: 0n,
      },
    });

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
  });

  it('stays bind-ready when auto-connect succeeds after the surface is toggled', async () => {
    detailMock.mockResolvedValue(detail());
    let resolveControls: (value: {
      modes: never[];
      current_mode: null;
      config_options: never[];
    }) => void = () => {};
    ensureSessionControlsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveControls = resolve;
      })
    );

    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useConversationTimeline(CONVERSATION_ID, { active }),
      { initialProps: { active: true } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(ensureSessionControlsMock).toHaveBeenCalled());
    expect(result.current.connecting).toBe(true);

    rerender({ active: false });
    rerender({ active: true });

    act(() => {
      resolveControls({
        modes: [],
        current_mode: null,
        config_options: [],
      });
    });

    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
    expect(result.current.connecting).toBe(false);
  });

  it('does not surface a stale auto-connect connection miss as a load error', async () => {
    detailMock.mockResolvedValue(detail());
    ensureSessionControlsMock.mockRejectedValueOnce(
      new Error(
        'Not found: agent connection `46054836-6607-4f56-a4c1-376afc469934` was not found'
      )
    );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.connecting).toBe(true);
  });

  it('marks the session bind-ready from a live SessionBindReady event', async () => {
    detailMock.mockResolvedValue(detail());
    let resolveControls: (value: {
      modes: never[];
      current_mode: null;
      config_options: never[];
    }) => void = () => {};
    ensureSessionControlsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveControls = resolve;
      })
    );

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(agentEventListeners.length).toBeGreaterThan(0));
    expect(result.current.connecting).toBe(true);

    act(() => {
      agentEventListeners[0]?.({
        session_id: CONVERSATION_ID,
        event: { kind: 'session_bind_ready', acp_session_id: 'acp-1' },
      });
    });

    await waitFor(() => expect(result.current.sessionBindReady).toBe(true));
    expect(result.current.connecting).toBe(false);
    resolveControls({
      modes: [],
      current_mode: null,
      config_options: [],
    });
  });

  it('keeps projected controls for a zero-message conversation while auto-connecting', async () => {
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

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessionConfigOptions).toEqual([
      expect.objectContaining({ key: 'fast-mode', value: 'off' }),
    ]);
    await waitFor(() =>
      expect(ensureSessionControlsMock).toHaveBeenCalledWith(CONVERSATION_ID, {
        reload: false,
      })
    );
  });

  it('does not add event-log rows on subscribe', async () => {
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
    expect(eventsSinceMock).not.toHaveBeenCalled();
    expect(result.current.timeline).toHaveLength(0);
  });

  it('reloads the file window when a live batch skips sequences', async () => {
    const opened = {
      ...detail(),
      timeline: {
        ...detail().timeline,
        last_sequence: 1n,
        rows: [userRow('t1', 'q', 1n)],
      },
    };
    const reloaded = {
      ...detail(),
      timeline: {
        ...detail().timeline,
        last_sequence: 6n,
        rows: [userRow('t1', 'q', 1n), assistantRow('t1', 'hello', 6n)],
      },
    };
    detailMock.mockResolvedValueOnce(opened).mockResolvedValue(reloaded);

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

    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(2));
    expect(eventsSinceMock).not.toHaveBeenCalled();
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
