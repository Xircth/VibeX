import type {
  AgentAvailableCommand,
  AgentSessionConfigOption,
  AgentSessionControlsSnapshot,
  AgentSessionMode,
  ContentBlock,
  ConversationRowOp,
  ConversationRowOpBatch,
  ConversationTimeline,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

import {
  getSessionComposerStructuredTokens,
  serializeSessionComposerBackendMessage,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

/**
 * Dumb-container conversation store (消灭双投影).
 *
 * The backend `ProjectionFold` is the single projector. The frontend never folds
 * events — it only:
 *   - upserts backend-computed `TimelineRow`s by `row_id` (idempotent by `revision`), and
 *   - concatenates streaming text into a per-row `liveText` overlay (cleared when that
 *     row is next upserted).
 * Initial load, live stream, and gap backfill all consume the same `TimelineRow`.
 */

/** Agent-advertised session modes for a conversation, plus the current one. */
export type ConversationSessionModesState = {
  current: string | null;
  modes: AgentSessionMode[];
};

export type ConversationGapState =
  | { kind: 'none' }
  | { kind: 'gap'; expectedSequence: bigint; receivedSequence: bigint };

export type ConversationTimelineTurn = {
  key: string;
  // 'interrupted' is the terminal phase for a turn orphaned by a host crash
  // (ADR-0001): rendered with a distinct "因重启中断" treatment + one-click resend.
  phase:
    | 'persisted'
    | 'optimistic'
    | 'streaming'
    | 'settled'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  turn: MessageTurn;
  revision: bigint;
};

export type ConversationTimelineItem =
  | { kind: 'message'; revision: bigint; item: ConversationTimelineTurn }
  | { kind: 'side'; revision: bigint; row: TimelineRow };

/** Accumulated streaming text for one row, since its last upsert. */
export type LiveTextOverlay = {
  text: string;
  reasoning: string;
  /** Highest applied append revision, for idempotent dedup. */
  revision: bigint;
};

export type ConversationStoreEntry = {
  conversationId: string;
  detail: DbConversationDetail | null;
  /** Authoritative rows from the backend projector, keyed by `row_id`. */
  rows: TimelineRow[];
  /** Per-row streaming-text overlay (`row_id` → chunks since last upsert). */
  liveText: Record<string, LiveTextOverlay>;
  lastSequence: bigint;
  projectionVersion: number | null;
  currentTurnId: string | null;
  loading: boolean;
  error: string | null;
  gap: ConversationGapState;
  optimisticTurns: MessageTurn[];
  // Agent-advertised session controls (delivered alongside row-op batches). Drive the
  // composer's mode/config picker; empty until the agent advertises them.
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
  /** Agent-advertised slash/skill catalog. `null` until the first update. */
  availableCommands: AgentAvailableCommand[] | null;
  olderCursor: string | null;
};

export type ConversationStoreState = {
  byConversationId: Record<string, ConversationStoreEntry>;
};

export type ConversationStoreAction =
  | { type: 'load_start'; conversationId: string }
  | {
      type: 'load_success';
      conversationId: string;
      detail: DbConversationDetail;
    }
  | { type: 'load_error'; conversationId: string; error: string }
  | {
      type: 'session_controls_hydrated';
      conversationId: string;
      controls: AgentSessionControlsSnapshot;
    }
  | { type: 'row_ops'; batch: ConversationRowOpBatch }
  | {
      type: 'upsert_rows';
      conversationId: string;
      rows: TimelineRow[];
      lastSequence: bigint;
      olderCursor?: string | null;
    }
  | { type: 'optimistic_turn'; conversationId: string; turn: MessageTurn }
  | { type: 'remove_optimistic_turn'; conversationId: string; turnId: string }
  | { type: 'reset'; conversationId: string };

export const emptyConversationStoreState: ConversationStoreState = {
  byConversationId: {},
};

export function conversationStoreReducer(
  state: ConversationStoreState,
  action: ConversationStoreAction
): ConversationStoreState {
  switch (action.type) {
    case 'load_start':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        loading: true,
        error: null,
      }));
    case 'load_success':
      return updateEntry(state, action.conversationId, (entry) => {
        const detailLastSequence = toBigInt(
          action.detail.timeline.last_sequence
        );
        // If live row ops have advanced past the reloaded projection, keep them —
        // otherwise a slow `conversation_detail` response would rewind the timeline.
        const keepRealtimeRows = entry.lastSequence > detailLastSequence;
        const reconciledTimeline = reconcileOptimisticTurnsAgainstRows(
          entry.optimisticTurns,
          action.detail.timeline.rows
        );
        return {
          ...entry,
          detail: action.detail,
          rows: keepRealtimeRows ? entry.rows : reconciledTimeline.rows,
          liveText: keepRealtimeRows
            ? entry.liveText
            : retainStreamingLiveText(reconciledTimeline.rows, entry.liveText),
          lastSequence: keepRealtimeRows
            ? entry.lastSequence
            : detailLastSequence,
          projectionVersion: action.detail.projection_version,
          currentTurnId: action.detail.current_turn?.id ?? entry.currentTurnId,
          loading: false,
          error: null,
          gap: { kind: 'none' },
          optimisticTurns: keepRealtimeRows
            ? reconcileOptimisticTurns(
                entry.optimisticTurns,
                action.detail.timeline
              )
            : reconciledTimeline.optimisticTurns,
          // Hydrate agent-advertised session controls from the persisted event
          // log so a reopened conversation renders real ACP pickers immediately;
          // live row-op batches keep them fresh afterwards.
          sessionModes: action.detail.session_modes
            ? {
                current: action.detail.session_modes.current ?? null,
                modes: action.detail.session_modes.modes,
              }
            : entry.sessionModes,
          sessionConfigOptions:
            action.detail.session_config_options &&
            action.detail.session_config_options.length > 0
              ? action.detail.session_config_options
              : entry.sessionConfigOptions,
          availableCommands:
            action.detail.available_commands !== undefined &&
            action.detail.available_commands !== null
              ? action.detail.available_commands
              : entry.availableCommands,
          olderCursor: keepRealtimeRows
            ? entry.olderCursor
            : (action.detail.timeline.older_cursor ?? null),
        };
      });
    case 'load_error':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        loading: false,
        error: action.error,
      }));
    case 'session_controls_hydrated':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        sessionModes: {
          current: action.controls.current_mode ?? null,
          modes: action.controls.modes,
        },
        sessionConfigOptions: action.controls.config_options,
        availableCommands:
          action.controls.available_commands ?? entry.availableCommands,
      }));
    case 'row_ops':
      return updateEntry(state, action.batch.conversation_id, (entry) =>
        applyRowOpBatch(entry, action.batch)
      );
    case 'upsert_rows':
      return updateEntry(state, action.conversationId, (entry) => {
        let rows = entry.rows;
        let liveText = entry.liveText;
        let optimisticTurns = entry.optimisticTurns;
        const rowIndexById = new Map(
          rows.map((row, index) => [row.row_id, index] as const)
        );
        for (const row of action.rows) {
          const reconciled = reconcileOptimisticTurnAgainstUserRow(
            optimisticTurns,
            row
          );
          optimisticTurns = reconciled.optimisticTurns;
          const applied = upsertRow(
            rows,
            liveText,
            reconciled.row,
            rowIndexById
          );
          rows = applied.rows;
          liveText = applied.liveText;
        }
        return {
          ...entry,
          rows,
          liveText,
          optimisticTurns,
          lastSequence:
            action.lastSequence > entry.lastSequence
              ? action.lastSequence
              : entry.lastSequence,
          olderCursor:
            action.olderCursor !== undefined
              ? action.olderCursor
              : entry.olderCursor,
          gap: { kind: 'none' },
        };
      });
    case 'optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: [...entry.optimisticTurns, action.turn],
      }));
    case 'remove_optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: entry.optimisticTurns.filter(
          (turn) => turn.id !== action.turnId
        ),
      }));
    case 'reset': {
      const next = { ...state.byConversationId };
      delete next[action.conversationId];
      return { byConversationId: next };
    }
  }
}

function applyRowOpBatch(
  entry: ConversationStoreEntry,
  batch: ConversationRowOpBatch
): ConversationStoreEntry {
  let rows = entry.rows;
  let liveText = entry.liveText;
  let currentTurnId = entry.currentTurnId;
  let optimisticTurns = entry.optimisticTurns;
  const rowIndexById = new Map(
    rows.map((row, index) => [row.row_id, index] as const)
  );

  for (const op of batch.ops) {
    if (op.op === 'upsert') {
      const reconciled = reconcileOptimisticTurnAgainstUserRow(
        optimisticTurns,
        op.row
      );
      optimisticTurns = reconciled.optimisticTurns;
      const applied = upsertRow(rows, liveText, reconciled.row, rowIndexById);
      rows = applied.rows;
      liveText = applied.liveText;
      if (
        op.row.row.kind === 'message_turn' &&
        op.row.row.turn.role === 'user'
      ) {
        currentTurnId = turnIdOfRowId(op.row.row_id) ?? currentTurnId;
      }
    } else if (op.op === 'delete') {
      const revision = toBigInt(op.revision);
      const existingIndex = rowIndexById.get(op.row_id);
      const existing =
        existingIndex === undefined ? undefined : rows[existingIndex];
      if (existing && revision >= toBigInt(existing.revision)) {
        rows = rows.filter((row) => row.row_id !== op.row_id);
        rowIndexById.clear();
        rows.forEach((row, index) => rowIndexById.set(row.row_id, index));
      }
      const overlay = liveText[op.row_id];
      if (overlay && revision >= overlay.revision) {
        liveText = { ...liveText };
        delete liveText[op.row_id];
      }
    } else {
      liveText = appendLiveText(liveText, rows, currentTurnId, op);
    }
  }

  const lastSequence = toBigInt(batch.last_sequence);
  const gap = detectSequenceGap(entry.lastSequence, batch);
  return {
    ...entry,
    rows,
    liveText,
    currentTurnId,
    optimisticTurns,
    lastSequence:
      lastSequence > entry.lastSequence ? lastSequence : entry.lastSequence,
    gap,
    sessionModes: batch.session_modes
      ? {
          current: batch.session_modes.current ?? null,
          modes: batch.session_modes.modes,
        }
      : entry.sessionModes,
    sessionConfigOptions:
      batch.session_config_options ?? entry.sessionConfigOptions,
    availableCommands: batch.available_commands ?? entry.availableCommands,
  };
}

/** Insert or replace a row by `row_id` (idempotent by `revision`), clearing its live text. */
function upsertRow(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  incoming: TimelineRow,
  rowIndexById?: Map<string, number>
): { rows: TimelineRow[]; liveText: Record<string, LiveTextOverlay> } {
  const incomingRevision = toBigInt(incoming.revision);
  const index =
    rowIndexById?.get(incoming.row_id) ??
    rows.findIndex((row) => row.row_id === incoming.row_id);
  let nextRows = rows;
  let applied = false;
  if (index === undefined || index === -1) {
    nextRows = [...rows, incoming];
    rowIndexById?.set(incoming.row_id, nextRows.length - 1);
    applied = true;
  } else if (incomingRevision >= toBigInt(rows[index].revision)) {
    const mergedIncoming = preserveStructuredUserText(rows[index], incoming);
    nextRows = rows.slice();
    nextRows[index] = mergedIncoming;
    applied = true;
  }
  // Drop the streaming overlay only when we actually applied a row whose revision is at
  // least the overlay's — that row already folds in every text delta up to its revision.
  // A rejected (stale) upsert, or one whose revision is *behind* the overlay (a late /
  // reordered duplicate), must NOT clear the overlay, or its newer streamed text would
  // vanish until the next real event re-upserts the row (丢字).
  let nextLive = liveText;
  const overlay = liveText[incoming.row_id];
  if (applied && overlay && incomingRevision >= overlay.revision) {
    nextLive = { ...liveText };
    delete nextLive[incoming.row_id];
  }
  return { rows: nextRows, liveText: nextLive };
}

/**
 * User turns are immutable after submission, but agent runtimes echo slash/skill
 * commands as normalized plain text. Once the optimistic turn has supplied the
 * richer serialized token, keep that presentation payload across every later
 * projector revision of the same row. Non-text blocks and row metadata remain
 * authoritative.
 */
function preserveStructuredUserText(
  existing: TimelineRow,
  incoming: TimelineRow
): TimelineRow {
  if (
    existing.row.kind !== 'message_turn' ||
    existing.row.turn.role !== 'user' ||
    incoming.row.kind !== 'message_turn' ||
    incoming.row.turn.role !== 'user'
  ) {
    return incoming;
  }

  const existingText = userTurnText(existing.row.turn);
  const incomingText = userTurnText(incoming.row.turn);
  if (
    getSessionComposerStructuredTokens(existingText).length === 0 ||
    getSessionComposerStructuredTokens(incomingText).length > 0
  ) {
    return incoming;
  }

  const existingTextBlocks = existing.row.turn.blocks.filter(
    (block) => block.type === 'text'
  );
  const incomingNonTextBlocks = incoming.row.turn.blocks.filter(
    (block) => block.type !== 'text'
  );

  return {
    ...incoming,
    row: {
      ...incoming.row,
      turn: {
        ...incoming.row.turn,
        blocks: [...existingTextBlocks, ...incomingNonTextBlocks],
      },
    },
  };
}

function appendLiveText(
  liveText: Record<string, LiveTextOverlay>,
  rows: TimelineRow[],
  _currentTurnId: string | null,
  op: Extract<ConversationRowOp, { op: 'append_text' }>
): Record<string, LiveTextOverlay> {
  if (isLateSettledAssistantAppend(rows, op.row_id)) {
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
  };
  return { ...liveText, [rowId]: next };
}

const TERMINAL_ROW_PHASES = new Set([
  'persisted',
  'settled',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Late chunks that still name a settled predecessor belong to that finished
 * turn. Drop them instead of grafting onto the open turn (ADR-0071). */
function isLateSettledAssistantAppend(
  rows: TimelineRow[],
  rowId: string
): boolean {
  if (!rowId.endsWith(':assistant')) return false;
  const existing = rows.find((row) => row.row_id === rowId);
  return (
    existing?.row.kind === 'message_turn' &&
    TERMINAL_ROW_PHASES.has(existing.row.phase)
  );
}

function retainStreamingLiveText(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): Record<string, LiveTextOverlay> {
  const next: Record<string, LiveTextOverlay> = {};
  const rowById = new Map(rows.map((row) => [row.row_id, row]));
  for (const [rowId, overlay] of Object.entries(liveText)) {
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
    if (overlay.revision > toBigInt(existing.revision)) {
      next[rowId] = overlay;
    }
  }
  return next;
}

export function timelineTurnsForEntry(
  entry: ConversationStoreEntry | null
): ConversationTimelineTurn[] {
  if (!entry) return [];
  const persisted = entry.rows.flatMap((row) => {
    if (row.row.kind !== 'message_turn') return [];
    const overlay = liveOverlayForRow(row, entry.liveText);
    const turn = overlay
      ? {
          ...row.row.turn,
          blocks: overlayLiveText(row.row.turn.blocks, overlay),
        }
      : row.row.turn;
    return [
      {
        key: `conversation-${row.row_id}`,
        turn,
        revision: toBigInt(row.revision),
        phase: row.row.phase as ConversationTimelineTurn['phase'],
      },
    ];
  });
  const optimistic = entry.optimisticTurns.map((turn, index) => ({
    key: `optimistic-${turn.id}`,
    turn,
    revision: entry.lastSequence + BigInt(index + 1),
    phase: 'optimistic' as const,
  }));
  return alignStreamingAssistantWithUserPhase(
    withPendingAssistantTurns(entry, dedupeTurns([...persisted, ...optimistic]))
  );
}

function liveOverlayForRow(
  row: TimelineRow,
  liveText: Record<string, LiveTextOverlay>
): LiveTextOverlay | undefined {
  if (row.row.kind !== 'message_turn') return undefined;
  if (TERMINAL_ROW_PHASES.has(row.row.phase)) return undefined;
  return liveText[row.row_id];
}

const TERMINAL_USER_PHASES = new Set<ConversationTimelineTurn['phase']>([
  'settled',
  'failed',
  'cancelled',
  'interrupted',
]);

function alignStreamingAssistantWithUserPhase(
  turns: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  const userPhaseById = new Map(
    turns
      .filter((row) => row.turn.role === 'user')
      .map((row) => [row.turn.id, row.phase])
  );

  return turns.map((row) => {
    if (row.turn.role !== 'assistant' || row.phase !== 'streaming') return row;
    const userId = row.turn.id.endsWith(':assistant')
      ? `${row.turn.id.slice(0, -':assistant'.length)}:user`
      : null;
    if (!userId) return row;
    const userPhase = userPhaseById.get(userId);
    if (!userPhase || !TERMINAL_USER_PHASES.has(userPhase)) return row;
    return { ...row, phase: userPhase };
  });
}

/** Side rows (everything that is not a message turn), carrying their stable `row_id`. */
export function sideRowsForEntry(
  entry: ConversationStoreEntry | null
): TimelineRow[] {
  return entry?.rows.filter((row) => row.row.kind !== 'message_turn') ?? [];
}

const INLINE_SIDE_ROW_KINDS = new Set([
  'terminal_summary',
  'delegation',
  'artifact_revision',
  'feedback_request',
  'question_request',
  'session_notice',
]);

/** Message turns and inlined side rows, ordered by revision to match the event log. */
export function timelineItemsForEntry(
  entry: ConversationStoreEntry | null,
  shouldInline: (row: TimelineRow) => boolean = defaultInlineSideRow
): ConversationTimelineItem[] {
  const messages = timelineTurnsForEntry(entry).map((item) => ({
    kind: 'message' as const,
    revision: item.revision,
    item,
  }));
  const sides = sideRowsForEntry(entry)
    .filter(shouldInline)
    .map((row) => ({
      kind: 'side' as const,
      revision: toBigInt(row.revision),
      row,
    }));
  return [...messages, ...sides].sort((left, right) => {
    if (left.kind === 'message' && right.kind === 'message') {
      return 0;
    }
    if (left.revision === right.revision) {
      if (left.kind === right.kind) return 0;
      return left.kind === 'message' ? -1 : 1;
    }
    return left.revision < right.revision ? -1 : 1;
  });
}

export function defaultInlineSideRow(row: TimelineRow): boolean {
  return INLINE_SIDE_ROW_KINDS.has(row.row.kind);
}

function createEntry(conversationId: string): ConversationStoreEntry {
  return {
    conversationId,
    detail: null,
    rows: [],
    liveText: {},
    lastSequence: 0n,
    projectionVersion: null,
    currentTurnId: null,
    loading: false,
    error: null,
    gap: { kind: 'none' },
    optimisticTurns: [],
    sessionModes: { current: null, modes: [] },
    sessionConfigOptions: [],
    availableCommands: null,
    olderCursor: null,
  };
}

function updateEntry(
  state: ConversationStoreState,
  conversationId: string,
  update: (entry: ConversationStoreEntry) => ConversationStoreEntry
): ConversationStoreState {
  const current =
    state.byConversationId[conversationId] ?? createEntry(conversationId);
  return {
    byConversationId: {
      ...state.byConversationId,
      [conversationId]: update(current),
    },
  };
}

/** Merge streaming overlay into the existing text/thinking blocks. */
function overlayLiveText(
  blocks: ContentBlock[],
  overlay: LiveTextOverlay
): ContentBlock[] {
  const result = [...blocks];
  if (overlay.reasoning) {
    mergeOverlayBlock(result, 'thinking', overlay.reasoning);
  }
  if (overlay.text) {
    mergeOverlayBlock(result, 'text', overlay.text);
  }
  return result;
}

function mergeOverlayBlock(
  result: ContentBlock[],
  type: 'text' | 'thinking',
  overlay: string
) {
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const block = result[index];
    if (block?.type !== type) {
      continue;
    }
    result[index] = {
      type,
      text: mergeOverlayText(block.text, overlay),
    };
    return;
  }
  result.push({ type, text: overlay });
}

/**
 * Combine persisted text with a live overlay without duplicating a shared
 * prefix or suffix. A late upsert of "hello" plus an overlay of "he" must
 * stay "hello", while a true delta of "llo" after "he" still becomes "hello".
 */
function mergeOverlayText(existing: string, overlay: string): string {
  if (!overlay) return existing;
  if (!existing) return overlay;
  if (overlay.startsWith(existing)) return overlay;
  if (existing.startsWith(overlay) || existing.endsWith(overlay)) {
    return existing;
  }
  return existing + overlay;
}

function detectSequenceGap(
  lastSequence: bigint,
  batch: ConversationRowOpBatch
): ConversationGapState {
  const incomingLast = toBigInt(batch.last_sequence);
  if (lastSequence <= 0n || incomingLast <= lastSequence) {
    return { kind: 'none' };
  }
  const revisions = batch.ops.map(opRevision);
  const minRevision =
    revisions.length > 0
      ? revisions.reduce((lowest, revision) =>
          revision < lowest ? revision : lowest
        )
      : incomingLast;
  if (minRevision > lastSequence + 1n) {
    return {
      kind: 'gap',
      expectedSequence: lastSequence + 1n,
      receivedSequence: minRevision,
    };
  }
  return { kind: 'none' };
}

function opRevision(op: ConversationRowOp): bigint {
  return op.op === 'upsert' ? toBigInt(op.row.revision) : toBigInt(op.revision);
}

function turnIdOfRowId(rowId: string): string | null {
  const suffix = ':user';
  return rowId.endsWith(suffix) ? rowId.slice(0, -suffix.length) : null;
}

function reconcileOptimisticTurns(
  optimisticTurns: MessageTurn[],
  timeline: ConversationTimeline
): MessageTurn[] {
  let remaining = [...optimisticTurns];
  for (const row of timeline.rows) {
    if (row.row.kind !== 'message_turn' || row.row.turn.role !== 'user') {
      continue;
    }
    const reconciled = reconcileOptimisticTurnAgainstUserRow(remaining, row);
    remaining = reconciled.optimisticTurns;
  }
  return remaining;
}

function reconcileOptimisticTurnsAgainstRows(
  optimisticTurns: MessageTurn[],
  rows: TimelineRow[]
): { rows: TimelineRow[]; optimisticTurns: MessageTurn[] } {
  let remainingTurns = optimisticTurns;
  const reconciledRows = [...rows].reverse().map((row) => {
    const reconciled = reconcileOptimisticTurnAgainstUserRow(
      remainingTurns,
      row
    );
    remainingTurns = reconciled.optimisticTurns;
    return reconciled.row;
  });
  return {
    rows: reconciledRows.reverse(),
    optimisticTurns: remainingTurns,
  };
}

function reconcileOptimisticTurnAgainstUserRow(
  optimisticTurns: MessageTurn[],
  row: TimelineRow
): { row: TimelineRow; optimisticTurns: MessageTurn[] } {
  if (
    row.row.kind !== 'message_turn' ||
    row.row.turn.role !== 'user' ||
    optimisticTurns.length === 0
  ) {
    return { row, optimisticTurns };
  }

  const authoritativeText = userTurnText(row.row.turn);
  let optimisticIndex = optimisticTurns.findIndex(
    (turn) => userTurnText(turn) === authoritativeText
  );

  if (optimisticIndex < 0) {
    const authoritativeBackendText =
      serializeSessionComposerBackendMessage(authoritativeText).trim();
    optimisticIndex = optimisticTurns.findIndex(
      (turn) =>
        serializeSessionComposerBackendMessage(userTurnText(turn)).trim() ===
        authoritativeBackendText
    );
  }

  if (optimisticIndex < 0) return { row, optimisticTurns };

  const optimisticTurn = optimisticTurns[optimisticIndex];
  const optimisticTextBlocks = optimisticTurn.blocks.filter(
    (block) => block.type === 'text'
  );
  const authoritativeNonTextBlocks = row.row.turn.blocks.filter(
    (block) => block.type !== 'text'
  );
  const reconciledRow: TimelineRow = {
    ...row,
    row: {
      ...row.row,
      turn: {
        ...row.row.turn,
        blocks: [...optimisticTextBlocks, ...authoritativeNonTextBlocks],
      },
    },
  };

  return {
    row: reconciledRow,
    optimisticTurns: optimisticTurns.filter(
      (_, index) => index !== optimisticIndex
    ),
  };
}

function userTurnText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function dedupeTurns(
  turns: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  const retain = new Map<string, number>();
  turns.forEach((entry, index) => {
    const key = `${entry.turn.role}:${entry.turn.id}`;
    if (!retain.has(key) || entry.turn.role !== 'user') {
      retain.set(key, index);
    }
  });
  return turns.filter((entry, index) => {
    const key = `${entry.turn.role}:${entry.turn.id}`;
    return retain.get(key) === index;
  });
}

/**
 * Synthesize a streaming assistant bubble for any turn that is streaming but whose
 * assistant row hasn't been upserted yet — driven by the `liveText` overlay (pure-text
 * streaming before the turn settles) and by optimistic user turns. Terminal user
 * phases (`settled` / `interrupted`, ADR-0001) never spawn a phantom bubble.
 */
function withPendingAssistantTurns(
  entry: ConversationStoreEntry,
  turns: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  const result = [...turns];
  const assistantIds = new Set(
    turns
      .filter((row) => row.turn.role === 'assistant')
      .map((row) => row.turn.id)
  );

  for (const [rowId, overlay] of Object.entries(entry.liveText)) {
    if (!rowId.endsWith(':assistant') || assistantIds.has(rowId)) continue;
    const userId = `${rowId.slice(0, -':assistant'.length)}:user`;
    const userTurn = turns.find(
      (row) => row.turn.role === 'user' && row.turn.id === userId
    );
    if (
      !userTurn ||
      userTurn.phase === 'settled' ||
      userTurn.phase === 'failed' ||
      userTurn.phase === 'cancelled' ||
      userTurn.phase === 'interrupted'
    ) {
      continue;
    }
    result.push({
      key: `conversation-${rowId}`,
      phase: 'streaming',
      revision: overlay.revision,
      turn: {
        id: rowId,
        role: 'assistant',
        blocks: overlayLiveText([], overlay),
        timestamp: userTurn.turn.timestamp,
      },
    });
    assistantIds.add(rowId);
  }

  // A sent user turn remains in-flight while it transitions from the optimistic
  // client row to the backend-projected streaming row. Keep one empty assistant
  // bubble across that handoff so the waiting indicator never disappears before
  // the first assistant delta arrives.
  const pendingUser = [...turns]
    .reverse()
    .find(
      (row) =>
        row.turn.role === 'user' &&
        (row.phase === 'optimistic' || row.phase === 'streaming')
    );
  if (pendingUser) {
    const assistantId = pendingUser.turn.id.endsWith(':user')
      ? `${pendingUser.turn.id.slice(0, -':user'.length)}:assistant`
      : `${pendingUser.turn.id}:assistant`;
    if (!assistantIds.has(assistantId)) {
      result.push({
        key: `conversation-${assistantId}`,
        phase: 'streaming',
        revision: pendingUser.revision,
        turn: {
          id: assistantId,
          role: 'assistant',
          blocks: [],
          timestamp: pendingUser.turn.timestamp,
        },
      });
    }
  }

  return result;
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
