import type {
  AgentSessionConfigOption,
  AgentSessionMode,
  ContentBlock,
  ConversationRowOp,
  ConversationRowOpBatch,
  ConversationTimeline,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

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
  phase: 'persisted' | 'optimistic' | 'streaming' | 'settled' | 'interrupted';
  turn: MessageTurn;
};

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
  | { type: 'row_ops'; batch: ConversationRowOpBatch }
  | {
      type: 'upsert_rows';
      conversationId: string;
      rows: TimelineRow[];
      lastSequence: bigint;
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
        return {
          ...entry,
          detail: action.detail,
          rows: keepRealtimeRows ? entry.rows : action.detail.timeline.rows,
          liveText: keepRealtimeRows ? entry.liveText : {},
          lastSequence: keepRealtimeRows ? entry.lastSequence : detailLastSequence,
          projectionVersion: action.detail.projection_version,
          currentTurnId: action.detail.current_turn?.id ?? entry.currentTurnId,
          loading: false,
          error: null,
          gap: { kind: 'none' },
          optimisticTurns: reconcileOptimisticTurns(
            entry.optimisticTurns,
            action.detail.timeline
          ),
        };
      });
    case 'load_error':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        loading: false,
        error: action.error,
      }));
    case 'row_ops':
      return updateEntry(
        state,
        action.batch.conversation_id,
        (entry) => applyRowOpBatch(entry, action.batch)
      );
    case 'upsert_rows':
      return updateEntry(state, action.conversationId, (entry) => {
        let rows = entry.rows;
        let liveText = entry.liveText;
        for (const row of action.rows) {
          const applied = upsertRow(rows, liveText, row);
          rows = applied.rows;
          liveText = applied.liveText;
        }
        return {
          ...entry,
          rows,
          liveText,
          lastSequence:
            action.lastSequence > entry.lastSequence
              ? action.lastSequence
              : entry.lastSequence,
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

  for (const op of batch.ops) {
    if (op.op === 'upsert') {
      const applied = upsertRow(rows, liveText, op.row);
      rows = applied.rows;
      liveText = applied.liveText;
      // A user message-turn upsert marks the active turn and clears the matching
      // optimistic bubble (matched by text; the ids differ).
      if (
        op.row.row.kind === 'message_turn' &&
        op.row.row.turn.role === 'user'
      ) {
        currentTurnId = turnIdOfRowId(op.row.row_id) ?? currentTurnId;
        optimisticTurns = reconcileOptimisticTurnsAgainstUser(
          optimisticTurns,
          op.row.row.turn
        );
      }
    } else {
      liveText = appendLiveText(liveText, op);
    }
  }

  const lastSequence = toBigInt(batch.last_sequence);
  return {
    ...entry,
    rows,
    liveText,
    currentTurnId,
    optimisticTurns,
    lastSequence:
      lastSequence > entry.lastSequence ? lastSequence : entry.lastSequence,
    gap: { kind: 'none' },
    sessionModes: batch.session_modes
      ? {
          current: batch.session_modes.current ?? null,
          modes: batch.session_modes.modes,
        }
      : entry.sessionModes,
    sessionConfigOptions:
      batch.session_config_options ?? entry.sessionConfigOptions,
  };
}

/** Insert or replace a row by `row_id` (idempotent by `revision`), clearing its live text. */
function upsertRow(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  incoming: TimelineRow
): { rows: TimelineRow[]; liveText: Record<string, LiveTextOverlay> } {
  const incomingRevision = toBigInt(incoming.revision);
  const index = rows.findIndex((row) => row.row_id === incoming.row_id);
  let nextRows = rows;
  let applied = false;
  if (index === -1) {
    nextRows = [...rows, incoming];
    applied = true;
  } else if (incomingRevision >= toBigInt(rows[index].revision)) {
    nextRows = rows.map((row, i) => (i === index ? incoming : row));
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

function appendLiveText(
  liveText: Record<string, LiveTextOverlay>,
  op: Extract<ConversationRowOp, { op: 'append_text' }>
): Record<string, LiveTextOverlay> {
  const revision = toBigInt(op.revision);
  const existing = liveText[op.row_id];
  if (existing && revision <= existing.revision) return liveText; // already applied
  const base = existing ?? { text: '', reasoning: '', revision: 0n };
  const next: LiveTextOverlay = {
    text: op.stream === 'text' ? base.text + op.delta : base.text,
    reasoning:
      op.stream === 'reasoning' ? base.reasoning + op.delta : base.reasoning,
    revision,
  };
  return { ...liveText, [op.row_id]: next };
}

export function timelineTurnsForEntry(
  entry: ConversationStoreEntry | null
): ConversationTimelineTurn[] {
  if (!entry) return [];
  const persisted = entry.rows.flatMap((row, index) => {
    if (row.row.kind !== 'message_turn') return [];
    const overlay = entry.liveText[row.row_id];
    const turn = overlay
      ? { ...row.row.turn, blocks: overlayLiveText(row.row.turn.blocks, overlay) }
      : row.row.turn;
    return [
      {
        key: `conversation-${row.row_id}-${index}`,
        turn,
        phase: row.row.phase as ConversationTimelineTurn['phase'],
      },
    ];
  });
  const optimistic = entry.optimisticTurns.map((turn, index) => ({
    key: `optimistic-${turn.id}-${index}`,
    turn,
    phase: 'optimistic' as const,
  }));
  return withPendingAssistantTurns(
    entry,
    dedupeTurns([...persisted, ...optimistic])
  );
}

/** Side rows (everything that is not a message turn), carrying their stable `row_id`. */
export function sideRowsForEntry(
  entry: ConversationStoreEntry | null
): TimelineRow[] {
  return entry?.rows.filter((row) => row.row.kind !== 'message_turn') ?? [];
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

/** Append the streaming overlay (reasoning then text) as trailing blocks. */
function overlayLiveText(
  blocks: ContentBlock[],
  overlay: LiveTextOverlay
): ContentBlock[] {
  const result = [...blocks];
  if (overlay.reasoning) {
    result.push({ type: 'thinking', text: overlay.reasoning });
  }
  if (overlay.text) {
    result.push({ type: 'text', text: overlay.text });
  }
  return result;
}

function turnIdOfRowId(rowId: string): string | null {
  const suffix = ':user';
  return rowId.endsWith(suffix) ? rowId.slice(0, -suffix.length) : null;
}

function reconcileOptimisticTurns(
  optimisticTurns: MessageTurn[],
  timeline: ConversationTimeline
): MessageTurn[] {
  const persistedText = new Set(
    timeline.rows.flatMap((row) =>
      row.row.kind === 'message_turn' && row.row.turn.role === 'user'
        ? [userTurnText(row.row.turn)]
        : []
    )
  );
  return optimisticTurns.filter(
    (turn) => !persistedText.has(userTurnText(turn))
  );
}

function reconcileOptimisticTurnsAgainstUser(
  optimisticTurns: MessageTurn[],
  userTurn: MessageTurn
): MessageTurn[] {
  const text = userTurnText(userTurn);
  return optimisticTurns.filter((turn) => userTurnText(turn) !== text);
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
    turns.filter((row) => row.turn.role === 'assistant').map((row) => row.turn.id)
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
      userTurn.phase === 'interrupted'
    ) {
      continue;
    }
    result.push({
      key: `pending-${rowId}`,
      phase: 'streaming',
      turn: {
        id: rowId,
        role: 'assistant',
        blocks: overlayLiveText([], overlay),
        timestamp: userTurn.turn.timestamp,
      },
    });
    assistantIds.add(rowId);
  }

  // Optimistic user turn with no backend/assistant row yet → empty streaming bubble.
  const optimisticUser = [...turns]
    .reverse()
    .find((row) => row.phase === 'optimistic' && row.turn.role === 'user');
  if (optimisticUser) {
    const assistantId = `${optimisticUser.turn.id}:assistant`;
    if (!assistantIds.has(assistantId)) {
      result.push({
        key: `pending-${assistantId}`,
        phase: 'streaming',
        turn: {
          id: assistantId,
          role: 'assistant',
          blocks: [],
          timestamp: optimisticUser.turn.timestamp,
        },
      });
    }
  }

  return result;
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
