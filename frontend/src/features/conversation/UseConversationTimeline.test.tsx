import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTimeline } from './useConversationTimeline';
import type {
  ConversationEventEnvelope,
  DbConversationDetail,
} from 'shared/types';

const { detailMock, eventsSinceMock, listenMock, listeners } = vi.hoisted(
  () => {
    const listeners = [] as Array<(event: ConversationEventEnvelope) => void>;
    return {
      listeners,
      detailMock: vi.fn(),
      eventsSinceMock: vi.fn(),
      listenMock: vi.fn(
        (handler: (event: ConversationEventEnvelope) => void) => {
          listeners.push(handler);
          return Promise.resolve(() => {});
        }
      ),
    };
  }
);

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
      id: 'conversation-1',
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Conversation',
      title_locked: false,
      status: 'inprogress',
      agent_type: 'codex',
      model: null,
      external_session_id: null,
      message_count: 0n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-06-14T00:00:00.000Z',
      updated_at: '2026-06-14T00:00:00.000Z',
    },
    turns: [],
    timeline: {
      conversation_id: 'conversation-1',
      projection_version: 1,
      last_sequence: 0n,
      rows: [],
    },
    projection_version: 1,
  };
}

function event(
  sequence: bigint,
  event: ConversationEventEnvelope['event'] = {
    kind: 'assistant_text_delta',
    text: 'hello',
    message_id: null,
  }
): ConversationEventEnvelope {
  return {
    id: `event-${sequence}`,
    conversation_id: 'conversation-1',
    turn_id: 'turn-1',
    sequence,
    source: 'acp',
    created_at: '2026-06-14T00:00:00.000Z',
    event,
  };
}

describe('useConversationTimeline', () => {
  // The hook coalesces live events on requestAnimationFrame. Capture scheduled
  // callbacks so tests can flush a frame deterministically (real rAF ids are
  // positive, so the truthy ids here keep the hook's "already scheduled" guard
  // working — a value of 0 would break it).
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

  it('loads projected detail and applies conversation events', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline('conversation-1')
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      listeners[0]?.(event(1n));
    });
    act(() => flushFrames());

    await waitFor(() => expect(result.current.timeline).toHaveLength(1));
    expect(result.current.timeline[0].turn.role).toBe('assistant');
  });

  it('recovers the user turn when the first realtime event starts after sequence one', async () => {
    detailMock.mockResolvedValue(detail());
    eventsSinceMock.mockResolvedValue({
      conversation_id: 'conversation-1',
      after_sequence: 0n,
      last_sequence: 2n,
      has_more: false,
      events: [
        event(1n, {
          kind: 'user_turn_created',
          blocks: [{ kind: 'text', text: 'sent message' }],
        }),
        event(2n),
      ],
    });

    const { result } = renderHook(() =>
      useConversationTimeline('conversation-1')
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      listeners[0]?.(event(2n));
    });

    await waitFor(() =>
      expect(eventsSinceMock).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        afterSequence: 0n,
        limit: 200,
      })
    );
    await waitFor(() => expect(result.current.timeline).toHaveLength(2));
    expect(result.current.timeline.map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('folds streamed realtime deltas into a single assistant turn', async () => {
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline('conversation-1')
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]?.(
        event(1n, {
          kind: 'user_turn_created',
          blocks: [{ kind: 'text', text: 'stream please' }],
        })
      );
      for (let index = 0; index < 24; index += 1) {
        listeners[0]?.(
          event(BigInt(index + 2), {
            kind: 'assistant_text_delta',
            text: 'x',
            message_id: null,
          })
        );
      }
    });
    // One frame coalesces the whole burst into a single dispatch.
    act(() => flushFrames());

    // Every contiguous delta is applied (no gap backfill) and folded into one
    // assistant turn once the per-frame flush settles.
    expect(eventsSinceMock).not.toHaveBeenCalled();
    expect(result.current.timeline).toHaveLength(2);
    const assistant = result.current.timeline.find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.blocks).toEqual([
      { type: 'text', text: 'x'.repeat(24) },
    ]);
  });
});
