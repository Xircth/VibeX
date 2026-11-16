import { describe, expect, it } from 'vitest';
import type { ConversationTimelineRow, TimelineRow } from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  type ResettableConversationRowOpBatch,
} from './conversationStore';
import {
  MAX_PARKED_ROWS,
  coalescePendingRowOpBatches,
  parkEntryWindowRows,
} from './timelineRegistryHelpers';

function emptyEntry(conversationId = 'conv-1') {
  const started = conversationStoreReducer(emptyConversationStoreState, {
    type: 'load_start',
    conversationId,
  });
  return started.byConversationId[conversationId]!;
}

function makeAppendBatch(
  conversationId: string,
  seq: bigint,
  rowId: string,
  delta: string,
  overrides: Partial<ResettableConversationRowOpBatch> = {}
): ResettableConversationRowOpBatch {
  return {
    conversation_id: conversationId,
    last_sequence: seq,
    ops: [
      {
        op: 'append_text',
        row_id: rowId,
        revision: seq,
        stream: 'text',
        delta,
      },
    ],
    session_modes: null,
    session_config_options: null,
    ...overrides,
  };
}

function makeMessageRow(index: number): TimelineRow {
  const row: ConversationTimelineRow = {
    kind: 'message_turn',
    phase: 'settled',
    turn: {
      id: `turn-${index}:assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `msg ${index}` }],
      timestamp: '2026-08-24T00:00:00.000Z',
    },
  };
  return {
    row_id: `turn-${index}:assistant`,
    revision: BigInt(index + 1),
    row,
  };
}

describe('coalescePendingRowOpBatches', () => {
  it('merges contiguous pure-append batches for the same row and stream', () => {
    const coalesced = coalescePendingRowOpBatches([
      makeAppendBatch('conv-1', 10n, 'turn-1:assistant', 'Hello', {
        previous_sequence: 9n,
      }),
      makeAppendBatch('conv-1', 11n, 'turn-1:assistant', ' ', {
        previous_sequence: 10n,
      }),
      makeAppendBatch('conv-1', 12n, 'turn-1:assistant', 'world', {
        previous_sequence: 11n,
      }),
    ]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.last_sequence).toBe(12n);
    expect(coalesced[0]!.ops).toEqual([
      {
        op: 'append_text',
        row_id: 'turn-1:assistant',
        revision: 12n,
        stream: 'text',
        delta: 'Hello world',
      },
    ]);
  });

  it('preserves lowest op revision floor when previous_sequence is absent', () => {
    const first = makeAppendBatch('conv-1', 10n, 'turn-1:assistant', 'A');
    const second = makeAppendBatch('conv-1', 11n, 'turn-1:assistant', 'B');
    const third = makeAppendBatch('conv-1', 12n, 'turn-1:assistant', 'C');

    const coalesced = coalescePendingRowOpBatches([first, second, third]);
    expect(coalesced).toHaveLength(1);
    // First op preserves lowest revision (10n); subsequent ops coalesce onto the tail.
    expect(coalesced[0]!.ops).toEqual([
      {
        op: 'append_text',
        row_id: 'turn-1:assistant',
        revision: 10n,
        stream: 'text',
        delta: 'A',
      },
      {
        op: 'append_text',
        row_id: 'turn-1:assistant',
        revision: 12n,
        stream: 'text',
        delta: 'BC',
      },
    ]);
  });

  it('respects reset, metadata, conversation, and sequence-gap barriers', () => {
    const b1 = makeAppendBatch('conv-1', 10n, 'turn-1:assistant', 'A', {
      previous_sequence: 9n,
    });
    const gap = makeAppendBatch('conv-1', 15n, 'turn-1:assistant', 'B', {
      previous_sequence: 14n,
    });
    const metadata = makeAppendBatch('conv-1', 16n, 'turn-1:assistant', 'C', {
      previous_sequence: 15n,
      session_modes: { current: 'default', modes: [] },
    });
    const reset = makeAppendBatch('conv-1', 17n, 'turn-1:assistant', 'D', {
      previous_sequence: 16n,
      reset: true,
    });
    const otherConv = makeAppendBatch('conv-2', 18n, 'turn-1:assistant', 'E');

    const coalesced = coalescePendingRowOpBatches([
      b1,
      gap,
      metadata,
      reset,
      otherConv,
    ]);
    expect(coalesced).toHaveLength(5);
  });
});

describe('parkEntryWindowRows', () => {
  it('trims oversized windowRows to MAX_PARKED_ROWS and resets cursor/prefixHash', () => {
    const rows = Array.from({ length: MAX_PARKED_ROWS + 12 }, (_, idx) =>
      makeMessageRow(idx)
    );
    const parked = parkEntryWindowRows({
      ...emptyEntry(),
      windowRows: rows,
      rows,
      liveRows: [makeMessageRow(99)],
      liveText: {
        'turn-99:assistant': { text: 'hi', reasoning: '', revision: 99n },
      },
      settledAssistantRowIds: { 'turn-1:assistant': true },
      lastSequence: 200n,
      loadedLastSequence: 199n,
      olderCursor: 'cursor-1',
      loadedToStart: true,
      prefixHash: 'hash-abc',
      loading: true,
      gap: { kind: 'gap', expectedSequence: 5n, receivedSequence: 7n },
    });

    expect(parked.windowRows).toHaveLength(MAX_PARKED_ROWS);
    expect(parked.windowRows[0]!.row_id).toBe('turn-12:assistant');
    expect(parked.windowRows.at(-1)!.row_id).toBe(
      `turn-${MAX_PARKED_ROWS + 11}:assistant`
    );
    expect(parked.rows).toBe(parked.windowRows);
    expect(parked.liveRows).toEqual([]);
    expect(parked.liveText).toEqual({});
    expect(parked.settledAssistantRowIds).toEqual({});
    expect(parked.lastSequence).toBe(0n);
    expect(parked.loadedLastSequence).toBe(0n);
    expect(parked.olderCursor).toBeNull();
    expect(parked.loadedToStart).toBe(false);
    expect(parked.prefixHash).toBeNull();
    expect(parked.loading).toBe(false);
    expect(parked.gap).toEqual({ kind: 'none' });
  });

  it('preserves olderCursor, loadedToStart, and prefixHash when windowRows <= MAX_PARKED_ROWS', () => {
    const rows = Array.from({ length: 10 }, (_, idx) => makeMessageRow(idx));
    const parked = parkEntryWindowRows({
      ...emptyEntry(),
      windowRows: rows,
      rows,
      olderCursor: 'cursor-keep',
      loadedToStart: true,
      prefixHash: 'hash-keep',
    });

    expect(parked.windowRows).toHaveLength(10);
    expect(parked.olderCursor).toBe('cursor-keep');
    expect(parked.loadedToStart).toBe(true);
    expect(parked.prefixHash).toBe('hash-keep');
  });
});
