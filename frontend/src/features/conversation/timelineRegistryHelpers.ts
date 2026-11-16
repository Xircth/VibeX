import type {
  ConversationRowOp,
  ConversationRowOpBatch,
  TimelineRow,
} from 'shared/types';
import type {
  ConversationStoreEntry,
  ConversationStoreState,
  ResettableConversationRowOpBatch,
} from './conversationStore';

export const STREAM_FLUSH_FRAME_MS = 16;
export const STREAM_FLUSH_MAX_MS = 96;
export const STREAM_FLUSH_CHARS_PER_FRAME = 16 * 1024;
export const STREAM_FLUSH_BLOCK_CHARS = 128;
export const MAX_PARKED_ROWS = 48;

const TERMINAL_TURN_PHASES = new Set([
  'settled',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isResetBatch(batch: ResettableConversationRowOpBatch): boolean {
  return batch.reset === true;
}

export function streamFlushDelayMs(liveRunChars: number): number {
  const frames = Math.max(
    1,
    Math.ceil(liveRunChars / STREAM_FLUSH_CHARS_PER_FRAME)
  );
  return Math.min(STREAM_FLUSH_MAX_MS, STREAM_FLUSH_FRAME_MS * frames);
}

function batchHasMetadata(batch: ResettableConversationRowOpBatch): boolean {
  return (
    batch.session_modes != null ||
    batch.session_config_options != null ||
    batch.available_commands != null ||
    batch.session_goal != null ||
    batch.async_tasks != null ||
    batch.prompt_suggestion != null
  );
}

export function isPureAppendBatch(
  batch: ResettableConversationRowOpBatch
): boolean {
  if (isResetBatch(batch)) return false;
  if (batch.ops.length === 0) return false;
  if (batchHasMetadata(batch)) {
    return false;
  }
  return batch.ops.every((op) => op.op === 'append_text');
}

export function liveConversationChars(
  entry: ConversationStoreState['byConversationId'][string] | undefined,
  pendingBatches: readonly ConversationRowOpBatch[] = []
): number {
  let chars = 0;
  if (entry) {
    for (const overlay of Object.values(entry.liveText)) {
      chars += overlay.text.length + overlay.reasoning.length;
    }
    const liveRows = entry.liveRows;
    for (let r = liveRows.length - 1; r >= 0; r -= 1) {
      const row = liveRows[r];
      if (
        row &&
        row.row.kind === 'message_turn' &&
        row.row.turn.role === 'assistant' &&
        row.row.phase === 'streaming'
      ) {
        const blocks = row.row.turn.blocks;
        const lastIdx = blocks.length - 1;
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if (!block) continue;
          if (block.type === 'text' || block.type === 'thinking') {
            if (i === lastIdx && !entry.liveText[row.row_id]) {
              chars += block.text.length;
            }
          } else {
            chars += STREAM_FLUSH_BLOCK_CHARS;
          }
        }
        break;
      }
    }
  }
  for (const batch of pendingBatches) {
    for (const op of batch.ops) {
      if (op.op === 'append_text') {
        chars += op.delta.length;
      }
    }
  }
  return chars;
}

export function toBigIntSeq(value: unknown, fallback: bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function normalizeGapPage(
  raw: unknown,
  afterSequence: bigint
): { lastSequence: bigint; reset: boolean; ops: ConversationRowOp[] } {
  const rec =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const lastSequence = toBigIntSeq(
    rec.lastSequence ?? rec.last_sequence,
    afterSequence
  );
  const reset = Boolean(rec.reset);
  const ops: ConversationRowOp[] = [];
  if (Array.isArray(rec.ops)) {
    for (const op of rec.ops) {
      if (op && typeof op === 'object' && 'op' in op) {
        ops.push(op as ConversationRowOp);
      }
    }
  }
  if (Array.isArray(rec.rows)) {
    for (const candidate of rec.rows) {
      if (!candidate || typeof candidate !== 'object') continue;
      const rowRec = candidate as Record<string, unknown>;
      const rowId =
        typeof rowRec.row_id === 'string'
          ? rowRec.row_id
          : typeof rowRec.rowId === 'string'
            ? rowRec.rowId
            : null;
      if (!rowId) continue;
      if (
        rowRec.deleted === true ||
        rowRec.is_deleted === true ||
        rowRec.tombstone === true
      ) {
        ops.push({
          op: 'delete',
          row_id: rowId,
          revision: toBigIntSeq(rowRec.revision, lastSequence),
        });
      } else if (rowRec.row && typeof rowRec.row === 'object') {
        ops.push({ op: 'upsert', row: candidate as TimelineRow });
      }
    }
  }
  for (const list of [rec.tombstones, rec.deleted_rows, rec.deletedRows]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') {
        ops.push({ op: 'delete', row_id: item, revision: lastSequence });
      } else if (item && typeof item === 'object') {
        const itemRec = item as Record<string, unknown>;
        const rowId =
          typeof itemRec.row_id === 'string'
            ? itemRec.row_id
            : typeof itemRec.rowId === 'string'
              ? itemRec.rowId
              : null;
        if (rowId) {
          ops.push({
            op: 'delete',
            row_id: rowId,
            revision: toBigIntSeq(itemRec.revision, lastSequence),
          });
        }
      }
    }
  }
  const deletedRowIds = rec.deleted_row_ids ?? rec.deletedRowIds;
  if (Array.isArray(deletedRowIds)) {
    for (const rowId of deletedRowIds) {
      if (typeof rowId === 'string' && rowId.length > 0) {
        ops.push({ op: 'delete', row_id: rowId, revision: lastSequence });
      }
    }
  }
  return { lastSequence, reset, ops };
}

export function hasTerminalTurnOp(batch: ConversationRowOpBatch): boolean {
  return batch.ops.some(
    (op) =>
      op.op === 'upsert' &&
      ((op.row.row.kind === 'message_turn' &&
        TERMINAL_TURN_PHASES.has(op.row.row.phase)) ||
        op.row.row.kind === 'file_change_summary' ||
        op.row.row.kind === 'turn_error')
  );
}

function batchOpRev(op: ConversationRowOp): bigint {
  return toBigIntSeq(op.op === 'upsert' ? op.row.revision : op.revision, 0n);
}

function minBatchOpRev(ops: readonly ConversationRowOp[]): bigint | null {
  if (ops.length === 0) return null;
  let lowest = batchOpRev(ops[0]!);
  for (let i = 1; i < ops.length; i += 1) {
    const rev = batchOpRev(ops[i]!);
    if (rev < lowest) lowest = rev;
  }
  return lowest;
}

function coalesceBatchOps(
  ops: readonly ConversationRowOp[],
  hasExplicitPreviousSequence: boolean
): ConversationRowOp[] {
  if (ops.length <= 1) return ops.slice();
  const minRev = hasExplicitPreviousSequence ? null : minBatchOpRev(ops);
  const out: ConversationRowOp[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.op === 'append_text' &&
      op.op === 'append_text' &&
      prev.row_id === op.row_id &&
      prev.stream === op.stream &&
      // Preserve the batch's lowest op revision when `previous_sequence` is
      // absent so reducer gap detection computes the exact same floor.
      (hasExplicitPreviousSequence ||
        minRev === null ||
        batchOpRev(prev) > minRev) &&
      batchOpRev(op) > batchOpRev(prev)
    ) {
      out[out.length - 1] = {
        ...prev,
        revision: op.revision,
        delta: prev.delta + op.delta,
      };
      continue;
    }
    out.push(op);
  }
  return out;
}

function areContiguousPureAppendBatches(
  prev: ResettableConversationRowOpBatch,
  next: ResettableConversationRowOpBatch
): boolean {
  if (!isPureAppendBatch(prev) || !isPureAppendBatch(next)) return false;
  if (prev.conversation_id !== next.conversation_id) return false;
  const prevSeq = toBigIntSeq(prev.last_sequence, 0n);
  if (next.previous_sequence != null) {
    return toBigIntSeq(next.previous_sequence, 0n) <= prevSeq;
  }
  if (prevSeq <= 0n) return true;
  const nextMin = minBatchOpRev(next.ops);
  return nextMin !== null && nextMin <= prevSeq + 1n;
}

/**
 * Coalesce queued contiguous pure-append batches and adjacent `append_text`
 * operations for the same `(row_id, stream)` before invoking the store reducer.
 * Reset/metadata/gap boundaries remain untouched so sequence-gap detection and
 * barrier semantics stay exact.
 */
export function coalescePendingRowOpBatches(
  batches: readonly ResettableConversationRowOpBatch[]
): ResettableConversationRowOpBatch[] {
  if (batches.length === 0) return [];
  const mergedBatches: ResettableConversationRowOpBatch[] = [];
  for (const batch of batches) {
    const prev = mergedBatches[mergedBatches.length - 1];
    if (prev && areContiguousPureAppendBatches(prev, batch)) {
      const nextSeq = toBigIntSeq(batch.last_sequence, 0n);
      const prevSeq = toBigIntSeq(prev.last_sequence, 0n);
      mergedBatches[mergedBatches.length - 1] = {
        ...prev,
        last_sequence: nextSeq > prevSeq ? batch.last_sequence : prev.last_sequence,
        ops: [...prev.ops, ...batch.ops],
      };
      continue;
    }
    mergedBatches.push(batch);
  }
  return mergedBatches.map((batch) => {
    if (batch.ops.length <= 1) return batch;
    const coalescedOps = coalesceBatchOps(
      batch.ops,
      batch.previous_sequence != null
    );
    return coalescedOps.length === batch.ops.length
      ? batch
      : { ...batch, ops: coalescedOps };
  });
}

/**
 * Park an inactive conversation entry, trimming oversized hydrated `windowRows`
 * to a bounded hot tail (`MAX_PARKED_ROWS`). Whenever rows are trimmed from the
 * head, reset `olderCursor`/`loadedToStart`/`prefixHash` so reopening reloads a
 * consistent tail window instead of issuing stale `fromIndex: 0` or gapped
 * pagination requests.
 */
export function parkEntryWindowRows(
  entry: ConversationStoreEntry
): ConversationStoreEntry {
  const trimmed = entry.windowRows.length > MAX_PARKED_ROWS;
  const windowRows = trimmed
    ? entry.windowRows.slice(-MAX_PARKED_ROWS)
    : entry.windowRows;
  return {
    ...entry,
    windowRows,
    rows: windowRows,
    liveRows: [],
    liveText: {},
    settledAssistantRowIds: {},
    optimisticTurns: [],
    optimisticBaselineUserRowIds: {},
    lastSequence: 0n,
    loadedLastSequence: 0n,
    olderCursor: trimmed ? null : entry.olderCursor,
    loadedToStart: trimmed ? false : entry.loadedToStart,
    prefixHash: trimmed ? null : entry.prefixHash,
    loading: false,
    gap: { kind: 'none' },
  };
}
