import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTimeline } from './useConversationTimeline';
import type {
  ConversationRowOp,
  ConversationRowOpBatch,
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

const CONVERSATION_ID = 'conversation-1';

const { detailMock, eventsSinceMock, listenMock, listeners } = vi.hoisted(() => {
  const listeners = [] as Array<(batch: ConversationRowOpBatch) => void>;
  return {
    listeners,
    detailMock: vi.fn(),
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
    eventsSince: eventsSinceMock,
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
      agent_type: 'codex' as const,
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

function batch(ops: ConversationRowOp[], lastSequence: bigint): ConversationRowOpBatch {
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

  it('backfills changed rows on subscribe', async () => {
    detailMock.mockResolvedValue(detail());
    eventsSinceMock.mockResolvedValue(
      rowPage([userRow('t1', 'sent message', 1n), assistantRow('t1', 'ok', 2n)], 2n)
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

  it('accumulates streamed text deltas into one assistant bubble', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline(CONVERSATION_ID)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]?.(batch([{ op: 'upsert', row: userRow('t1', 'go', 1n) }], 1n));
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
});
