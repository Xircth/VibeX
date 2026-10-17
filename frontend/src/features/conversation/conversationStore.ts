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
  forkPointStatus?: 'named' | 'unnamed' | 'tail' | 'unsupported' | null;
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
  | { type: 'load_error'; conversationId: string; error: string | null }
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
      /** Older pages stay in memory even when they exceed the hot-tail budget. */
      protectLoaded?: boolean;
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
        // `rows` is the timeline the view renders. Keeping the same rows on
        // `detail` duplicated the open window for as long as the card was mounted.
        const detail = {
          ...action.detail,
          timeline: { ...action.detail.timeline, rows: [] },
        };
        return enforceTimelineBudget({
          ...entry,
          detail,
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
        });
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
        sessionModes:
          action.controls.modes.length > 0 || action.controls.current_mode
            ? {
                current: action.controls.current_mode ?? null,
                modes: action.controls.modes,
              }
            : entry.sessionModes,
        sessionConfigOptions:
          action.controls.config_options.length > 0
            ? action.controls.config_options
            : entry.sessionConfigOptions,
        availableCommands:
          action.controls.available_commands ?? entry.availableCommands,
      }));
    case 'row_ops':
      return updateEntry(state, action.batch.conversation_id, (entry) =>
        enforceTimelineBudget(applyRowOpBatch(entry, action.batch))
      );
    case 'upsert_rows':
      return updateEntry(state, action.conversationId, (entry) => {
        let rows = entry.rows;
        let liveText = entry.liveText;
        let optimisticTurns = entry.optimisticTurns;
        const protect = new Set<string>();
        if (action.protectLoaded) {
          const existing = new Set(rows.map((row) => row.row_id));
          const firstRevision = rows[0] ? toBigInt(rows[0].revision) : null;
          const older: TimelineRow[] = [];
          const updates: TimelineRow[] = [];
          for (const row of action.rows) {
            protect.add(row.row_id);
            const reconciled = reconcileOptimisticTurnAgainstUserRow(
              optimisticTurns,
              row
            );
            optimisticTurns = reconciled.optimisticTurns;
            if (
              !existing.has(row.row_id) &&
              (firstRevision === null ||
                toBigInt(row.revision) <= firstRevision)
            ) {
              older.push(reconciled.row);
              existing.add(row.row_id);
            } else {
              updates.push(reconciled.row);
            }
          }
          rows = [...older, ...rows];
          const rowIndexById = new Map(
            rows.map((row, index) => [row.row_id, index] as const)
          );
          for (const row of updates) {
            const applied = upsertRow(rows, liveText, row, rowIndexById);
            rows = applied.rows;
            liveText = applied.liveText;
          }
        } else {
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
        }
        return enforceTimelineBudget(
          {
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
          },
          protect
        );
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
    } else if (op.op === 'patch_blocks') {
      const applied = applyPatchBlocks(rows, liveText, op, rowIndexById);
      rows = applied.rows;
      liveText = applied.liveText;
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
    nextRows = insertTimelineRow(rows, incoming);
    rebuildRowIndex(nextRows, rowIndexById);
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

/** Hot tail of *settled* history kept in the renderer. Older rows reload
 * through `project_row_window`. An in-flight turn is outside this budget:
 * dropping or amputating it makes already-visible stream content vanish
 * while `append_text` keeps going. */
export const TIMELINE_RETAINED_ROW_LIMIT = 80;
export const TIMELINE_RETAINED_BYTE_BUDGET = 768 * 1024;
export const TIMELINE_ROW_BLOCK_TAIL = 24;

function applyPatchBlocks(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  rowIndexById: Map<string, number>
): { rows: TimelineRow[]; liveText: Record<string, LiveTextOverlay> } {
  const revision = toBigInt(op.revision);
  const index = rowIndexById.get(op.row_id);
  if (index === undefined) {
    if (revision < maxRowRevision(rows)) {
      return { rows, liveText };
    }
    const nextRows = insertTimelineRow(rows, stubAssistantRow(op));
    rebuildRowIndex(nextRows, rowIndexById);
    return { rows: nextRows, liveText };
  }
  const existing = rows[index];
  if (
    !existing ||
    revision < toBigInt(existing.revision) ||
    existing.row.kind !== 'message_turn'
  ) {
    return { rows, liveText };
  }
  const nextRows = rows.slice();
  nextRows[index] = {
    ...existing,
    revision: op.revision,
    row: {
      ...existing.row,
      phase: op.phase,
      turn: {
        ...existing.row.turn,
        blocks: mergePatchedBlocks(existing.row.turn.blocks, op.blocks),
        ...(op.usage ? { usage: op.usage } : {}),
      },
    },
  };
  return { rows: nextRows, liveText };
}

function stubAssistantRow(
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>
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
        timestamp: '1970-01-01T00:00:00.000Z',
        ...(op.usage ? { usage: op.usage } : {}),
      },
    },
  };
}

function mergePatchedBlocks(
  existing: ContentBlock[],
  incoming: ContentBlock[]
): ContentBlock[] {
  const next = existing.slice();
  for (const block of incoming) {
    if (block.type === 'tool_use') {
      const id = block.tool_use_id;
      const match = next.findIndex(
        (candidate) =>
          candidate.type === 'tool_use' &&
          Boolean(id) &&
          candidate.tool_use_id === id
      );
      if (match >= 0) next[match] = block;
      else next.push(block);
    } else if (block.type === 'tool_result') {
      const id = block.tool_use_id;
      const match = next.findIndex(
        (candidate) =>
          candidate.type === 'tool_result' &&
          Boolean(id) &&
          candidate.tool_use_id === id
      );
      if (match >= 0) next[match] = block;
      else next.push(block);
    } else if (block.type === 'plan') {
      const match = next.findIndex((candidate) => candidate.type === 'plan');
      if (match >= 0) next[match] = block;
      else next.push(block);
    } else {
      next.push(block);
    }
  }
  return next;
}

function maxRowRevision(rows: TimelineRow[]): bigint {
  let max = 0n;
  for (const row of rows) {
    const revision = toBigInt(row.revision);
    if (revision > max) max = revision;
  }
  return max;
}

export function enforceTimelineBudget(
  entry: ConversationStoreEntry,
  protectIds?: ReadonlySet<string>
): ConversationStoreEntry {
  const protect = new Set(protectIds ?? []);
  for (const rowId of inFlightProtectIds(entry)) protect.add(rowId);
  let rows = entry.rows;
  let dropped = 0;
  const over = () =>
    rows.length > TIMELINE_RETAINED_ROW_LIMIT ||
    estimateRowsBytes(rows) > TIMELINE_RETAINED_BYTE_BUDGET;
  while (rows.length > 1 && over()) {
    const front = rows[0];
    if (!front || protect.has(front.row_id)) break;
    rows = rows.slice(1);
    dropped += 1;
  }
  if (rows.length === 1 && over() && rows[0] && !protect.has(rows[0].row_id)) {
    rows = [trimRowBlocks(rows[0])];
  }
  if (dropped === 0 && rows === entry.rows) return entry;
  let liveText = entry.liveText;
  if (dropped > 0) {
    const kept = new Set(rows.map((row) => row.row_id));
    const nextLive: Record<string, LiveTextOverlay> = {};
    for (const [rowId, overlay] of Object.entries(liveText)) {
      if (kept.has(rowId)) nextLive[rowId] = overlay;
    }
    liveText = nextLive;
  }
  let olderCursor = entry.olderCursor;
  if (dropped > 0) {
    const current = olderCursor == null ? 0 : Number(olderCursor);
    const base = Number.isFinite(current) ? current : 0;
    olderCursor = String(base + dropped);
  }
  return { ...entry, rows, liveText, olderCursor };
}

function trimRowBlocks(row: TimelineRow): TimelineRow {
  if (row.row.kind !== 'message_turn') return row;
  const blocks = row.row.turn.blocks;
  if (blocks.length <= TIMELINE_ROW_BLOCK_TAIL) return row;
  return {
    ...row,
    row: {
      ...row.row,
      turn: {
        ...row.row.turn,
        blocks: blocks.slice(-TIMELINE_ROW_BLOCK_TAIL),
      },
    },
  };
}

function estimateRowsBytes(rows: TimelineRow[]): number {
  let total = 0;
  for (const row of rows) total += estimateValue(row.row);
  return total;
}

function estimateValue(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value === 'bigint') return 8;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += estimateValue(item);
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      total += estimateValue(item);
    }
    return total;
  }
  return 0;
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
        forkPointStatus:
          'fork_point_status' in row.row
            ? ((
                row.row as {
                  fork_point_status?: ConversationTimelineTurn['forkPointStatus'];
                }
              ).fork_point_status ?? null)
            : null,
      },
    ];
  });
  const maxRowRevision = entry.rows.reduce((max, row) => {
    const revision = toBigInt(row.revision);
    return revision > max ? revision : max;
  }, entry.lastSequence);
  const optimistic = entry.optimisticTurns.map((turn, index) => ({
    key: `optimistic-${turn.id}`,
    turn,
    revision: maxRowRevision + BigInt(index + 1),
    phase: 'optimistic' as const,
  }));
  return alignStreamingAssistantWithUserPhase(
    withPendingAssistantTurns(
      entry,
      orderSameTurnUserBeforeAssistant(
        mergeOptimisticUsersBeforeOrphanAssistants(
          dedupeTurns(persisted),
          optimistic
        )
      )
    )
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
const EMPTY_TIMELINE_ROWS: TimelineRow[] = [];
const sideRowsByEntryRows = new WeakMap<TimelineRow[], TimelineRow[]>();
const lastSideRowsByConversation = new Map<string, TimelineRow[]>();

export function sideRowsForEntry(
  entry: ConversationStoreEntry | null
): TimelineRow[] {
  if (!entry || entry.rows.length === 0) return EMPTY_TIMELINE_ROWS;
  const cached = sideRowsByEntryRows.get(entry.rows);
  if (cached) return cached;

  const filtered = entry.rows.filter((row) => row.row.kind !== 'message_turn');
  if (filtered.length === 0) {
    sideRowsByEntryRows.set(entry.rows, EMPTY_TIMELINE_ROWS);
    return EMPTY_TIMELINE_ROWS;
  }

  const convId = entry.conversationId;
  if (convId) {
    const prev = lastSideRowsByConversation.get(convId);
    if (
      prev &&
      prev.length === filtered.length &&
      prev.every((row, index) => row === filtered[index])
    ) {
      sideRowsByEntryRows.set(entry.rows, prev);
      return prev;
    }
    if (
      lastSideRowsByConversation.size >= 32 &&
      !lastSideRowsByConversation.has(convId)
    ) {
      const oldest = lastSideRowsByConversation.keys().next().value;
      if (oldest !== undefined) lastSideRowsByConversation.delete(oldest);
    }
    lastSideRowsByConversation.set(convId, filtered);
  }
  sideRowsByEntryRows.set(entry.rows, filtered);
  return filtered;
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
  shouldInline: (row: TimelineRow) => boolean = defaultInlineSideRow,
  precomputedTurns?: ConversationTimelineTurn[],
  precomputedSideRows?: TimelineRow[]
): ConversationTimelineItem[] {
  const turns = precomputedTurns ?? timelineTurnsForEntry(entry);
  const messages = turns.map((item) => ({
    kind: 'message' as const,
    revision: item.revision,
    item,
  }));
  const sideRows = precomputedSideRows ?? sideRowsForEntry(entry);
  const sortedSides = sideRows
    .filter(shouldInline)
    .map((row, index) => ({
      index,
      item: {
        kind: 'side' as const,
        revision: toBigInt(row.revision),
        row,
      },
    }))
    .sort((left, right) => {
      if (left.item.revision !== right.item.revision) {
        return left.item.revision < right.item.revision ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entryItem) => entryItem.item);

  if (sortedSides.length === 0) {
    return messages;
  }

  const maxSideRevision = sortedSides[sortedSides.length - 1]?.revision ?? 0n;
  const result: ConversationTimelineItem[] = [];
  let sideIndex = 0;
  let runningMaxRevision = 0n;

  for (const message of messages) {
    const isOptimisticOrZeroTrailing =
      message.item.phase === 'optimistic' ||
      (message.revision <= 0n &&
        (runningMaxRevision > 0n || maxSideRevision > 0n));
    const effectiveRevision = isOptimisticOrZeroTrailing
      ? (runningMaxRevision > maxSideRevision
          ? runningMaxRevision
          : maxSideRevision) + 1n
      : message.revision > runningMaxRevision
        ? message.revision
        : runningMaxRevision;
    runningMaxRevision = effectiveRevision;

    while (
      sideIndex < sortedSides.length &&
      sortedSides[sideIndex]!.revision < effectiveRevision
    ) {
      result.push(sortedSides[sideIndex]!);
      sideIndex += 1;
    }
    result.push(message);
  }

  while (sideIndex < sortedSides.length) {
    result.push(sortedSides[sideIndex]!);
    sideIndex += 1;
  }

  return result;
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
  const nextByConversationId = {
    ...state.byConversationId,
    [conversationId]: update(current),
  };
  return {
    byConversationId: nextByConversationId,
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
  // Match the backend projector: only extend the last block when it is already
  // this stream. Searching earlier text would glue a post-tool reply onto the
  // first assistant message.
  const last = result[result.length - 1];
  if (last?.type === type) {
    result[result.length - 1] = {
      type,
      text: mergeOverlayText(last.text, overlay),
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

/** `${turn}:user` | `${turn}:assistant` | `${turn}:assistant:N` | `${turn}:steer:{id}` */
function turnPrefixOfRowId(rowId: string): string | null {
  const match = /^(.*?):(user|assistant|steer)(?::|$)/.exec(rowId);
  return match?.[1] ?? null;
}

function inFlightProtectIds(entry: ConversationStoreEntry): Set<string> {
  const turnIds = new Set<string>();
  if (entry.currentTurnId) turnIds.add(entry.currentTurnId);
  for (const rowId of Object.keys(entry.liveText)) {
    const turnId = turnPrefixOfRowId(rowId);
    if (turnId) turnIds.add(turnId);
  }
  for (const row of entry.rows) {
    if (
      row.row.kind !== 'message_turn' ||
      (row.row.phase !== 'streaming' && row.row.phase !== 'optimistic')
    ) {
      continue;
    }
    const turnId = turnPrefixOfRowId(row.row_id);
    if (turnId) turnIds.add(turnId);
  }
  const ids = new Set<string>();
  for (const row of entry.rows) {
    if (entry.liveText[row.row_id]) ids.add(row.row_id);
    const turnId = turnPrefixOfRowId(row.row_id);
    if (turnId && turnIds.has(turnId)) ids.add(row.row_id);
  }
  return ids;
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
    result
      .filter((row) => row.turn.role === 'assistant')
      .map((row) => row.turn.id)
  );

  const insertAfter = (
    userTurn: ConversationTimelineTurn,
    pending: ConversationTimelineTurn
  ) => {
    const userIndex = result.findIndex(
      (row) => row.turn.id === userTurn.turn.id
    );
    result.splice(userIndex < 0 ? result.length : userIndex + 1, 0, pending);
    assistantIds.add(pending.turn.id);
  };

  for (const [rowId, overlay] of Object.entries(entry.liveText)) {
    if (!rowId.endsWith(':assistant') || assistantIds.has(rowId)) continue;
    const userId = `${rowId.slice(0, -':assistant'.length)}:user`;
    const userTurn = result.find(
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
    insertAfter(userTurn, {
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
  }

  // A sent user turn remains in-flight while it transitions from the optimistic
  // client row to the backend-projected streaming row. Keep one empty assistant
  // bubble across that handoff so the waiting indicator never disappears before
  // the first assistant delta arrives.
  const pendingUser = [...result]
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
    const hasOrphanAssistant = result.some(
      (row) =>
        row.turn.role === 'assistant' && !hasPairedUser(result, row.turn.id)
    );
    if (!assistantIds.has(assistantId) && !hasOrphanAssistant) {
      insertAfter(pendingUser, {
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

function messageTurnPairKey(id: string): string | null {
  if (id.endsWith(':user')) return id.slice(0, -':user'.length);
  const assistant = /^(.*):assistant(?::\d+)?$/.exec(id);
  if (assistant) return assistant[1];
  const steer = /^(.*):steer:/.exec(id);
  if (steer) return steer[1];
  return null;
}

function isPrimaryUserTurn(turn: ConversationTimelineTurn): boolean {
  return turn.turn.role === 'user' && turn.turn.id.endsWith(':user');
}

function isPrimaryUserRow(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' &&
    row.row.turn.role === 'user' &&
    row.row_id.endsWith(':user')
  );
}

/** Same-turn user rows always render before that turn's assistant / steering slices. */
function orderSameTurnUserBeforeAssistant(
  turns: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  const result = [...turns];
  const keys = new Set<string>();
  for (const turn of result) {
    const key = messageTurnPairKey(turn.turn.id);
    if (key) keys.add(key);
  }
  for (const key of keys) {
    const userIndex = result.findIndex(
      (turn) =>
        isPrimaryUserTurn(turn) && messageTurnPairKey(turn.turn.id) === key
    );
    const firstIndex = result.findIndex(
      (turn) => messageTurnPairKey(turn.turn.id) === key
    );
    if (userIndex < 0 || firstIndex < 0 || userIndex <= firstIndex) continue;
    const [user] = result.splice(userIndex, 1);
    if (user) result.splice(firstIndex, 0, user);
  }
  return result;
}

function hasPairedUser(
  turns: ConversationTimelineTurn[],
  assistantId: string
): boolean {
  const key = messageTurnPairKey(assistantId);
  if (!key) return false;
  return turns.some(
    (turn) =>
      isPrimaryUserTurn(turn) && messageTurnPairKey(turn.turn.id) === key
  );
}

/**
 * Optimistic user ids are temporary (`optimistic-*`). If the matching assistant
 * row already landed, keep that user in front of it instead of appending after.
 */
function mergeOptimisticUsersBeforeOrphanAssistants(
  persisted: ConversationTimelineTurn[],
  optimistic: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  if (optimistic.length === 0) return persisted;
  const result = [...persisted];
  const filledKeys = new Set<string>();
  for (const turn of optimistic) {
    const orphan = result.find((candidate) => {
      if (candidate.turn.role !== 'assistant') return false;
      const key = messageTurnPairKey(candidate.turn.id);
      if (!key || filledKeys.has(key)) return false;
      return !hasPairedUser(result, candidate.turn.id);
    });
    if (!orphan) {
      result.push(turn);
      continue;
    }
    const key = messageTurnPairKey(orphan.turn.id);
    if (key) filledKeys.add(key);
    const index = result.indexOf(orphan);
    result.splice(index < 0 ? result.length : index, 0, turn);
  }
  return result;
}

function insertTimelineRow(
  rows: TimelineRow[],
  incoming: TimelineRow
): TimelineRow[] {
  if (incoming.row.kind !== 'message_turn') {
    return [...rows, incoming];
  }
  const key = messageTurnPairKey(incoming.row_id);
  if (!key) return [...rows, incoming];

  let insertAt = rows.length;
  if (isPrimaryUserRow(incoming)) {
    const sibling = rows.findIndex(
      (row) => messageTurnPairKey(row.row_id) === key
    );
    if (sibling >= 0) insertAt = sibling;
  } else {
    for (let index = 0; index < rows.length; index += 1) {
      if (messageTurnPairKey(rows[index]?.row_id ?? '') === key) {
        insertAt = index + 1;
      }
    }
  }
  return [...rows.slice(0, insertAt), incoming, ...rows.slice(insertAt)];
}

function rebuildRowIndex(
  rows: TimelineRow[],
  rowIndexById?: Map<string, number>
) {
  if (!rowIndexById) return;
  rowIndexById.clear();
  rows.forEach((row, index) => rowIndexById.set(row.row_id, index));
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
