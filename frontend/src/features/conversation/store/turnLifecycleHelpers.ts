import type {
  ContentBlock,
  ConversationRowOp,
  ConversationRowOpBatch,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

import { plausibleTurnStartMs } from '@/components/conversation-thread/turnClock';
import {
  TERMINAL_ROW_PHASES,
  isLateSettledAssistantAppend,
  isLiveProjectorRowId,
  messageTurnPairKey,
  rebuildRowIndex,
  toBigInt,
} from './queue';
import type {
  ConversationGapState,
  ConversationStoreEntry,
  LiveTextOverlay,
} from './turnLifecycle';

export function normalizeAgentIdentity(
  raw: string | null | undefined
): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  return trimmed.toLowerCase().replace(/[-_\s]+/g, '');
}

export function collectUserRowIds(
  windowRows: TimelineRow[],
  liveRows: TimelineRow[]
): string[] {
  const seen = new Set<string>();
  for (const row of windowRows) {
    if (row.row.kind === 'message_turn' && row.row.turn.role === 'user') {
      seen.add(row.row_id);
    }
  }
  for (const row of liveRows) {
    if (row.row.kind === 'message_turn' && row.row.turn.role === 'user') {
      seen.add(row.row_id);
    }
  }
  return Array.from(seen);
}

export function pruneOptimisticBaselines(
  baselines: Record<string, string[]>,
  optimisticTurns: MessageTurn[]
): Record<string, string[]> {
  if (optimisticTurns.length === 0) return {};
  const activeIds = new Set(optimisticTurns.map((turn) => turn.id));
  const next: Record<string, string[]> = {};
  for (const [turnId, ids] of Object.entries(baselines)) {
    if (activeIds.has(turnId)) {
      next[turnId] = ids;
    }
  }
  return next;
}

export function extendOptimisticBaselines(
  baselines: Record<string, string[]>,
  optimisticTurns: MessageTurn[],
  extraUserRowIds: string[]
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...baselines };
  for (const turn of optimisticTurns) {
    const current = next[turn.id] ?? [];
    const merged = new Set([...current, ...extraUserRowIds]);
    next[turn.id] = Array.from(merged);
  }
  return next;
}

export function isTerminalMessageRow(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' && TERMINAL_ROW_PHASES.has(row.row.phase)
  );
}

export function isNonTerminalMessageRow(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' && !TERMINAL_ROW_PHASES.has(row.row.phase)
  );
}

export function isSettledAssistantRow(row: TimelineRow): boolean {
  return (
    row.row_id.endsWith(':assistant') &&
    row.row.kind === 'message_turn' &&
    TERMINAL_ROW_PHASES.has(row.row.phase)
  );
}

export function buildSettledAssistantRowIds(
  windowRows: readonly TimelineRow[],
  liveRows: readonly TimelineRow[]
): Record<string, true> {
  const settled: Record<string, true> = {};
  for (const row of windowRows) {
    if (isSettledAssistantRow(row)) {
      settled[row.row_id] = true;
    }
  }
  for (const row of liveRows) {
    if (isSettledAssistantRow(row)) {
      settled[row.row_id] = true;
    }
  }
  return settled;
}

export function markSettledAssistantRow(
  settled: Record<string, true>,
  rowId: string
): Record<string, true> {
  if (!rowId.endsWith(':assistant') || settled[rowId]) return settled;
  return { ...settled, [rowId]: true };
}

export function syncSettledAssistantRowId(
  settled: Record<string, true>,
  rowId: string,
  windowRows: readonly TimelineRow[],
  liveRows: readonly TimelineRow[]
): Record<string, true> {
  if (!rowId.endsWith(':assistant')) return settled;
  const stillSettled =
    isLateSettledAssistantAppend(liveRows as TimelineRow[], rowId) ||
    isLateSettledAssistantAppend(windowRows as TimelineRow[], rowId);
  if (stillSettled) {
    return settled[rowId] ? settled : { ...settled, [rowId]: true };
  }
  if (!settled[rowId]) return settled;
  const next = { ...settled };
  delete next[rowId];
  return next;
}

export function overlayRevisionHorizon(overlay: LiveTextOverlay): bigint {
  return overlay.patchedRevision !== undefined &&
    overlay.patchedRevision > overlay.revision
    ? overlay.patchedRevision
    : overlay.revision;
}

export function isOverlayAheadOfRevision(
  overlay: LiveTextOverlay,
  rowRevision: bigint
): boolean {
  if (overlay.revision > rowRevision) return true;
  return (
    overlay.patchedRevision !== undefined &&
    overlay.patchedRevision >= overlay.revision &&
    overlay.patchedRevision >= rowRevision
  );
}

export function applyDeleteTombstone(
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  rowId: string,
  revision: bigint,
  liveRowIndexById: Map<string, number>
): {
  windowRows: TimelineRow[];
  liveRows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
} {
  let nextWindowRows = windowRows;
  let nextLiveRows = liveRows;
  let nextLiveText = liveText;

  const existingIndex = liveRowIndexById.get(rowId);
  const existing =
    existingIndex === undefined ? undefined : nextLiveRows[existingIndex];
  if (existing && revision >= toBigInt(existing.revision)) {
    nextLiveRows = nextLiveRows.filter((row) => row.row_id !== rowId);
    rebuildRowIndex(nextLiveRows, liveRowIndexById);
  }
  const windowExisting = nextWindowRows.find((row) => row.row_id === rowId);
  if (windowExisting && revision >= toBigInt(windowExisting.revision)) {
    nextWindowRows = nextWindowRows.filter((row) => row.row_id !== rowId);
  }
  const overlay = nextLiveText[rowId];
  if (overlay && revision >= overlayRevisionHorizon(overlay)) {
    nextLiveText = { ...nextLiveText };
    delete nextLiveText[rowId];
  }
  return {
    windowRows: nextWindowRows,
    liveRows: nextLiveRows,
    liveText: nextLiveText,
  };
}

export function willAppendNewPatchedBlock(
  existing: ContentBlock[],
  incoming: ContentBlock[]
): boolean {
  for (const block of incoming) {
    if (block.type === 'tool_use') {
      const id = block.tool_use_id;
      const match = existing.some(
        (candidate) =>
          candidate.type === 'tool_use' &&
          Boolean(id) &&
          candidate.tool_use_id === id
      );
      if (!match) return true;
    } else if (block.type === 'tool_result') {
      continue;
    } else if (block.type === 'plan') {
      const match = existing.some((candidate) => candidate.type === 'plan');
      if (!match) return true;
    } else {
      return true;
    }
  }
  return false;
}

export function extractCurrentTurnStartedAt(
  detail: DbConversationDetail | null | undefined
): string | null {
  const turn = detail?.current_turn as
    | {
        started_at?: string | null;
        created_at?: string | null;
        startedAt?: string | null;
        createdAt?: string | null;
      }
    | null
    | undefined;
  const candidate =
    turn?.started_at ??
    turn?.created_at ??
    turn?.startedAt ??
    turn?.createdAt ??
    null;
  return candidate && plausibleTurnStartMs(candidate) !== null
    ? candidate
    : null;
}

export function selectActiveTurnStartedAt(
  entry: ConversationStoreEntry | null
): string | null {
  if (!entry) return null;
  const activeTurnId =
    entry.detail?.current_turn?.id ??
    entry.detail?.in_flight_user_turn_id ??
    entry.currentTurnId;
  if (activeTurnId) {
    const userId = `${activeTurnId}:user`;
    for (let index = entry.rows.length - 1; index >= 0; index -= 1) {
      const row = entry.rows[index];
      if (
        !row ||
        row.row.kind !== 'message_turn' ||
        row.row.turn.role !== 'user'
      ) {
        continue;
      }
      if (row.row_id !== userId && row.row.turn.id !== userId) continue;
      if (plausibleTurnStartMs(row.row.turn.timestamp) !== null) {
        return row.row.turn.timestamp;
      }
    }
  }
  return extractCurrentTurnStartedAt(entry.detail);
}

function findUserStartTimestampBackward(
  rows: readonly TimelineRow[] | undefined,
  userId: string
): string | null {
  if (!rows) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      !row ||
      row.row.kind !== 'message_turn' ||
      row.row.turn.role !== 'user'
    ) {
      continue;
    }
    if (row.row_id !== userId && row.row.turn.id !== userId) continue;
    if (plausibleTurnStartMs(row.row.turn.timestamp) !== null) {
      return row.row.turn.timestamp;
    }
  }
  return null;
}

export function assistantStartTimestamp(
  liveRows: readonly TimelineRow[],
  assistantRowId: string,
  fallbackStartedAt?: string | null,
  windowRows?: readonly TimelineRow[]
): string {
  const pair = messageTurnPairKey(assistantRowId);
  if (pair) {
    const userId = `${pair}:user`;
    const fromLive = findUserStartTimestampBackward(liveRows, userId);
    if (fromLive !== null) return fromLive;
    const fromWindow = findUserStartTimestampBackward(windowRows, userId);
    if (fromWindow !== null) return fromWindow;
  }
  if (fallbackStartedAt && plausibleTurnStartMs(fallbackStartedAt) !== null) {
    return fallbackStartedAt;
  }
  return new Date().toISOString();
}

export function stubAssistantRow(
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  liveRows: readonly TimelineRow[],
  fallbackStartedAt?: string | null,
  windowRows?: readonly TimelineRow[]
): TimelineRow {
  return {
    row_id: op.row_id,
    revision: op.revision,
    row: {
      kind: 'message_turn',
      phase: op.phase,
      turn: {
        id: op.row_id,
        role: 'assistant',
        blocks: op.blocks,
        timestamp: assistantStartTimestamp(
          liveRows,
          op.row_id,
          fallbackStartedAt,
          windowRows
        ),
        ...(op.usage ? { usage: op.usage } : {}),
      },
    },
  };
}

export function windowPrefixHash(detail: DbConversationDetail): string | null {
  const hash = (
    detail as DbConversationDetail & { prefix_hash?: string | null }
  ).prefix_hash;
  return hash ?? null;
}

export function maxLiveRowRevision(
  rows: TimelineRow[],
  conversationId?: string
): bigint {
  let max = 0n;
  for (const row of rows) {
    if (!isLiveProjectorRowId(row.row_id, conversationId)) continue;
    const revision = toBigInt(row.revision);
    if (revision > max) max = revision;
  }
  return max;
}

export function appendLiveText(
  liveText: Record<string, LiveTextOverlay>,
  settledAssistantRowIds: Record<string, true>,
  op: Extract<ConversationRowOp, { op: 'append_text' }>
): Record<string, LiveTextOverlay> {
  if (settledAssistantRowIds[op.row_id]) {
    return liveText;
  }
  const rowId = op.row_id;
  const revision = toBigInt(op.revision);
  const existing = liveText[rowId];
  if (existing && revision <= existing.revision) return liveText; // already applied
  const base = existing ?? { text: '', reasoning: '', revision: 0n };
  const next: LiveTextOverlay = {
    text: op.stream === 'text' ? base.text + op.delta : base.text,
    reasoning:
      op.stream === 'reasoning' ? base.reasoning + op.delta : base.reasoning,
    revision,
    ...(existing?.patchedRevision !== undefined &&
    existing.patchedRevision > revision
      ? { patchedRevision: existing.patchedRevision }
      : {}),
  };
  return { ...liveText, [rowId]: next };
}

export function retainStreamingLiveText(
  windowRows: readonly TimelineRow[],
  liveRows: readonly TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): Record<string, LiveTextOverlay> {
  const entries = Object.entries(liveText);
  if (entries.length === 0) return liveText;
  const next: Record<string, LiveTextOverlay> = {};
  const rowById = new Map<string, TimelineRow>();
  for (const row of windowRows) {
    rowById.set(row.row_id, row);
  }
  for (const row of liveRows) {
    rowById.set(row.row_id, row);
  }
  for (const [rowId, overlay] of entries) {
    const existing = rowById.get(rowId);
    if (!existing) {
      next[rowId] = overlay;
      continue;
    }
    if (
      existing.row.kind === 'message_turn' &&
      TERMINAL_ROW_PHASES.has(existing.row.phase)
    ) {
      continue;
    }
    if (isOverlayAheadOfRevision(overlay, toBigInt(existing.revision))) {
      next[rowId] = overlay;
    }
  }
  return next;
}

export function opRevision(op: ConversationRowOp): bigint {
  return op.op === 'upsert' ? toBigInt(op.row.revision) : toBigInt(op.revision);
}

export function detectSequenceGap(
  lastSequence: bigint,
  batch: ConversationRowOpBatch
): ConversationGapState {
  const incomingLast = toBigInt(batch.last_sequence);
  if (incomingLast <= lastSequence) {
    return { kind: 'none' };
  }
  if (batch.previous_sequence != null) {
    const previousSequence = toBigInt(batch.previous_sequence);
    if (previousSequence > lastSequence) {
      return {
        kind: 'gap',
        expectedSequence: lastSequence + 1n,
        receivedSequence: previousSequence + 1n,
      };
    }
    return { kind: 'none' };
  }
  if (lastSequence <= 0n) {
    return { kind: 'none' };
  }
  let minRevision = incomingLast;
  if (batch.ops.length > 0) {
    minRevision = opRevision(batch.ops[0]!);
    for (let i = 1; i < batch.ops.length; i += 1) {
      const revision = opRevision(batch.ops[i]!);
      if (revision < minRevision) {
        minRevision = revision;
      }
    }
  }
  if (minRevision > lastSequence + 1n) {
    return {
      kind: 'gap',
      expectedSequence: lastSequence + 1n,
      receivedSequence: minRevision,
    };
  }
  return { kind: 'none' };
}

export function turnIdOfRowId(rowId: string): string | null {
  const suffix = ':user';
  return rowId.endsWith(suffix) ? rowId.slice(0, -suffix.length) : null;
}
