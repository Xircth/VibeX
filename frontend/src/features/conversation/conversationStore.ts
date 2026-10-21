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
import { plausibleTurnStartMs } from '@/components/conversation-thread/turnClock';
import { mergeReportedTurnUsage } from './reportedTurnUsage';
import {
  mergeOpenTimelineRows,
  preferLoadedOlderCursor,
} from './timelinePaging';

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
  /** Persisted window rows from `get_conversation_detail_window` and older pagination. */
  windowRows: TimelineRow[];
  /** Live rows from the current unconverged turn's `row_ops` (`{turn}:user`, `{turn}:assistant`, steer, side rows). */
  liveRows: TimelineRow[];
  /** Combined rendered rows (`windowRows` followed by `liveRows`, aligned by turn position and prompt text). */
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
  /** Fingerprint of the turns above `olderCursor`, from the last window response. */
  prefixHash: string | null;
  /** Number of non-steer user turns before the loaded window offset. */
  userTurnsBeforeOffset: number;
  /** The loaded rows begin at transcript index 0. */
  loadedToStart: boolean;
  /** Increments when an older page is prepended, so scroll compensation is not keyed off the first row id. */
  olderTurnsPrependEpoch: number;
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
        const keepRealtimeRows = entry.lastSequence > detailLastSequence;
        const incomingRows = action.detail.timeline.rows;

        // Promote any in-flight live-id rows that were seeded into `windowRows`
        // (e.g. unit tests calling `loaded([streamingUser(...)])`) before replacing
        // `windowRows` with the server window.
        const priorLiveRows = promoteUnconvergedStreamingLiveRows(
          entry.windowRows,
          entry.liveRows,
          incomingRows
        );

        const incomingIds = new Set(incomingRows.map((row) => row.row_id));
        const baseWindowRows =
          keepRealtimeRows &&
          entry.windowRows.length > 0 &&
          entry.windowRows.some((row) => incomingIds.has(row.row_id))
            ? mergeOpenTimelineRows(entry.windowRows, incomingRows)
            : incomingRows;
        const droppedWindowSeed = dropSeededInitialPrompt(
          action.conversationId,
          baseWindowRows
        );
        const reconciledWindow = reconcileOptimisticTurnsAgainstRows(
          entry.optimisticTurns,
          droppedWindowSeed
        );
        const windowRows = preserveStructuredUserTextFromLiveRows(
          settleIdleOpenTail(
            dropSeededInitialPrompt(
              action.conversationId,
              reconciledWindow.rows
            ),
            Boolean(action.detail.in_flight_user_turn_id)
          ),
          priorLiveRows
        );

        const prunedLive = pruneConvergedLiveState(
          windowRows,
          priorLiveRows,
          entry.liveText,
          keepRealtimeRows
        );
        const liveRows = dropSeededInitialPrompt(
          action.conversationId,
          prunedLive.liveRows
        );
        const liveText = retainStreamingLiveText(
          [...windowRows, ...liveRows],
          prunedLive.liveText
        );
        const rows = combineWindowAndLiveRows(
          action.conversationId,
          windowRows,
          liveRows,
          liveText
        );

        // `rows` is the timeline the view renders. Keeping the same rows on
        // `detail` duplicated the open window for as long as the card was mounted.
        const detail = {
          ...action.detail,
          timeline: { ...action.detail.timeline, rows: [] },
        };
        return {
          ...entry,
          detail,
          windowRows,
          liveRows,
          rows,
          liveText,
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
            : reconciledWindow.optimisticTurns,
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
            ? preferLoadedOlderCursor(
                entry.olderCursor,
                action.detail.timeline.older_cursor,
                entry.windowRows.length > 0
              )
            : (action.detail.timeline.older_cursor ?? null),
          prefixHash: keepRealtimeRows
            ? (windowPrefixHash(action.detail) ?? entry.prefixHash)
            : windowPrefixHash(action.detail),
          userTurnsBeforeOffset: keepRealtimeRows
            ? entry.userTurnsBeforeOffset
            : Number(action.detail.user_turns_before_offset ?? 0),
          loadedToStart: keepRealtimeRows
            ? entry.loadedToStart
            : action.detail.timeline.older_cursor == null,
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
    case 'row_ops': {
      return updateEntry(state, action.batch.conversation_id, (entry) => {
        return applyRowOpBatch(entry, action.batch);
      });
    }
    case 'upsert_rows':
      return updateEntry(state, action.conversationId, (entry) => {
        let windowRows = entry.windowRows;
        let liveRows = entry.liveRows;
        let liveText = entry.liveText;
        let optimisticTurns = entry.optimisticTurns;
        let prepended = 0;
        let prependedUserTurns = 0;
        if (action.protectLoaded) {
          const existing = new Set(windowRows.map((row) => row.row_id));
          const older: TimelineRow[] = [];
          const updates: TimelineRow[] = [];
          for (const row of action.rows) {
            const reconciled = reconcileOptimisticTurnAgainstUserRow(
              optimisticTurns,
              row
            );
            optimisticTurns = reconciled.optimisticTurns;
            if (!existing.has(reconciled.row.row_id)) {
              older.push(reconciled.row);
              existing.add(reconciled.row.row_id);
              prepended += 1;
              if (
                reconciled.row.row.kind === 'message_turn' &&
                reconciled.row.row.turn.role === 'user' &&
                !reconciled.row.row_id.includes(':steer:')
              ) {
                prependedUserTurns += 1;
              }
            } else {
              updates.push(reconciled.row);
            }
          }
          windowRows = [...older, ...windowRows];
          if (updates.length > 0) {
            const rowIndexById = new Map(
              windowRows.map((row, index) => [row.row_id, index] as const)
            );
            for (const row of updates) {
              const applied = upsertRow(
                windowRows,
                liveText,
                row,
                rowIndexById
              );
              windowRows = applied.rows;
              liveText = applied.liveText;
            }
          }
          windowRows = dropSeededInitialPrompt(
            action.conversationId,
            windowRows
          );
        } else {
          const rowIndexById = new Map(
            liveRows.map((row, index) => [row.row_id, index] as const)
          );
          for (const row of action.rows) {
            const reconciled = reconcileOptimisticTurnAgainstUserRow(
              optimisticTurns,
              row
            );
            optimisticTurns = reconciled.optimisticTurns;
            const applied = upsertRow(
              liveRows,
              liveText,
              reconciled.row,
              rowIndexById,
              windowRows
            );
            liveRows = applied.rows;
            liveText = applied.liveText;
          }
          liveRows = dropSeededInitialPrompt(action.conversationId, liveRows);
        }
        const rows = combineWindowAndLiveRows(
          action.conversationId,
          windowRows,
          liveRows,
          liveText
        );
        return {
          ...entry,
          windowRows,
          liveRows,
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
          userTurnsBeforeOffset: Math.max(
            0,
            entry.userTurnsBeforeOffset - prependedUserTurns
          ),
          olderTurnsPrependEpoch:
            entry.olderTurnsPrependEpoch + (prepended > 0 ? 1 : 0),
          loadedToStart:
            entry.loadedToStart ||
            (action.olderCursor !== undefined && action.olderCursor == null),
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
  let windowRows = entry.windowRows;
  let liveRows = entry.liveRows;
  let liveText = entry.liveText;
  let currentTurnId = entry.currentTurnId;
  let optimisticTurns = entry.optimisticTurns;
  const rowIndexById = new Map(
    liveRows.map((row, index) => [row.row_id, index] as const)
  );

  for (const op of batch.ops) {
    if (op.op === 'upsert') {
      const reconciled = reconcileOptimisticTurnAgainstUserRow(
        optimisticTurns,
        op.row
      );
      optimisticTurns = reconciled.optimisticTurns;
      const applied = upsertRow(
        liveRows,
        liveText,
        reconciled.row,
        rowIndexById,
        windowRows
      );
      liveRows = applied.rows;
      liveText = applied.liveText;
      if (
        op.row.row.kind === 'message_turn' &&
        op.row.row.turn.role === 'user'
      ) {
        currentTurnId = turnIdOfRowId(op.row.row_id) ?? currentTurnId;
      }
    } else if (op.op === 'patch_blocks') {
      const applied = applyPatchBlocks(
        liveRows,
        liveText,
        op,
        rowIndexById,
        windowRows
      );
      liveRows = applied.rows;
      liveText = applied.liveText;
    } else if (op.op === 'delete') {
      const revision = toBigInt(op.revision);
      const existingIndex = rowIndexById.get(op.row_id);
      const existing =
        existingIndex === undefined ? undefined : liveRows[existingIndex];
      if (existing && revision >= toBigInt(existing.revision)) {
        liveRows = liveRows.filter((row) => row.row_id !== op.row_id);
        rebuildRowIndex(liveRows, rowIndexById);
      }
      const windowExisting = windowRows.find((row) => row.row_id === op.row_id);
      if (windowExisting && revision >= toBigInt(windowExisting.revision)) {
        windowRows = windowRows.filter((row) => row.row_id !== op.row_id);
      }
      const overlay = liveText[op.row_id];
      if (overlay && revision >= overlay.revision) {
        liveText = { ...liveText };
        delete liveText[op.row_id];
      }
    } else {
      liveText = appendLiveText(
        liveText,
        windowRows,
        liveRows,
        currentTurnId,
        op
      );
    }
  }

  liveRows = dropSeededInitialPrompt(entry.conversationId, liveRows);
  windowRows = dropSeededInitialPrompt(entry.conversationId, windowRows);
  const rows = combineWindowAndLiveRows(
    entry.conversationId,
    windowRows,
    liveRows,
    liveText
  );

  const lastSequence = toBigInt(batch.last_sequence);
  const gap = detectSequenceGap(entry.lastSequence, batch);
  return {
    ...entry,
    windowRows,
    liveRows,
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
  rowIndexById?: Map<string, number>,
  windowRows?: TimelineRow[]
): { rows: TimelineRow[]; liveText: Record<string, LiveTextOverlay> } {
  const incomingRevision = toBigInt(incoming.revision);
  const index =
    rowIndexById?.get(incoming.row_id) ??
    rows.findIndex((row) => row.row_id === incoming.row_id);
  let nextRows = rows;
  let applied = false;
  if (index === undefined || index === -1) {
    const windowExisting = windowRows?.find(
      (row) => row.row_id === incoming.row_id
    );
    if (
      windowExisting &&
      incomingRevision < toBigInt(windowExisting.revision)
    ) {
      return { rows, liveText };
    }
    const seededIncoming = windowExisting
      ? preserveAssistantBlocksOnColdUpsert(
          windowExisting,
          preserveStructuredUserText(windowExisting, incoming),
          liveText[incoming.row_id]
        )
      : incoming;
    nextRows = insertTimelineRow(rows, seededIncoming);
    rebuildRowIndex(nextRows, rowIndexById);
    applied = true;
  } else if (incomingRevision >= toBigInt(rows[index].revision)) {
    const mergedIncoming = preserveAssistantBlocksOnColdUpsert(
      rows[index],
      preserveStructuredUserText(rows[index], incoming),
      liveText[incoming.row_id]
    );
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

function withMergedTurnUsage(
  existing: TimelineRow,
  incoming: TimelineRow
): TimelineRow {
  if (
    existing.row.kind !== 'message_turn' ||
    incoming.row.kind !== 'message_turn'
  ) {
    return incoming;
  }
  return {
    ...incoming,
    row: {
      ...incoming.row,
      turn: {
        ...incoming.row.turn,
        usage: mergeReportedTurnUsage(
          existing.row.turn.usage,
          incoming.row.turn.usage
        ),
      },
    },
  };
}

function preserveAssistantBlocksOnColdUpsert(
  existing: TimelineRow,
  incoming: TimelineRow,
  overlay: LiveTextOverlay | undefined
): TimelineRow {
  if (
    existing.row.kind !== 'message_turn' ||
    existing.row.turn.role !== 'assistant' ||
    incoming.row.kind !== 'message_turn' ||
    incoming.row.turn.role !== 'assistant'
  ) {
    return incoming;
  }
  if (incoming.row.turn.blocks.length > 0) {
    return withMergedTurnUsage(existing, incoming);
  }
  const incomingRevision = toBigInt(incoming.revision);
  const baseBlocks =
    overlay && incomingRevision >= overlay.revision
      ? overlayLiveText(existing.row.turn.blocks, overlay)
      : existing.row.turn.blocks;
  if (baseBlocks.length === 0) {
    return incoming;
  }
  return {
    ...incoming,
    row: {
      ...incoming.row,
      turn: {
        ...incoming.row.turn,
        blocks: baseBlocks,
        usage: mergeReportedTurnUsage(
          existing.row.turn.usage,
          incoming.row.turn.usage
        ),
        duration_ms:
          incoming.row.turn.duration_ms ?? existing.row.turn.duration_ms,
        model: incoming.row.turn.model ?? existing.row.turn.model,
      },
    },
  };
}

function applyPatchBlocks(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  rowIndexById: Map<string, number>,
  windowRows?: TimelineRow[]
): { rows: TimelineRow[]; liveText: Record<string, LiveTextOverlay> } {
  const revision = toBigInt(op.revision);
  const index = rowIndexById.get(op.row_id);
  const overlay = liveText[op.row_id];
  if (index === undefined) {
    const windowExisting = windowRows?.find((row) => row.row_id === op.row_id);
    if (windowExisting && windowExisting.row.kind === 'message_turn') {
      if (revision < toBigInt(windowExisting.revision)) {
        return { rows, liveText };
      }
      const consumeOverlay = Boolean(
        overlay &&
          overlay.revision <= revision &&
          willAppendNewPatchedBlock(windowExisting.row.turn.blocks, op.blocks)
      );
      const baseBlocks =
        consumeOverlay && overlay
          ? overlayLiveText(windowExisting.row.turn.blocks, overlay)
          : windowExisting.row.turn.blocks;
      const patched: TimelineRow = {
        ...windowExisting,
        revision: op.revision,
        row: {
          ...windowExisting.row,
          phase: op.phase,
          turn: {
            ...windowExisting.row.turn,
            timestamp:
              plausibleTurnStartMs(windowExisting.row.turn.timestamp) !==
              null
                ? windowExisting.row.turn.timestamp
                : assistantStartTimestamp(rows, op.row_id),
            blocks: mergePatchedBlocks(baseBlocks, op.blocks),
            usage: mergeReportedTurnUsage(
              windowExisting.row.turn.usage,
              op.usage
            ),
          },
        },
      };
      const nextRows = insertTimelineRow(rows, patched);
      rebuildRowIndex(nextRows, rowIndexById);
      let nextLive = liveText;
      if (consumeOverlay) {
        nextLive = { ...liveText };
        delete nextLive[op.row_id];
      }
      return { rows: nextRows, liveText: nextLive };
    }
    if (revision < maxLiveRowRevision(rows)) {
      return { rows, liveText };
    }
    const consumeOverlay = Boolean(
      overlay && overlay.revision <= revision && op.blocks.length > 0
    );
    const baseBlocks =
      consumeOverlay && overlay ? overlayLiveText([], overlay) : [];
    const stub = stubAssistantRow(
      {
        ...op,
        blocks: mergePatchedBlocks(baseBlocks, op.blocks),
      },
      rows
    );
    const nextRows = insertTimelineRow(rows, stub);
    rebuildRowIndex(nextRows, rowIndexById);
    let nextLive = liveText;
    if (consumeOverlay) {
      nextLive = { ...liveText };
      delete nextLive[op.row_id];
    }
    return { rows: nextRows, liveText: nextLive };
  }
  const existing = rows[index];
  if (
    !existing ||
    revision < toBigInt(existing.revision) ||
    existing.row.kind !== 'message_turn'
  ) {
    return { rows, liveText };
  }
  const consumeOverlay = Boolean(
    overlay &&
      overlay.revision <= revision &&
      willAppendNewPatchedBlock(existing.row.turn.blocks, op.blocks)
  );
  const baseBlocks =
    consumeOverlay && overlay
      ? overlayLiveText(existing.row.turn.blocks, overlay)
      : existing.row.turn.blocks;
  const nextRows = rows.slice();
  nextRows[index] = {
    ...existing,
    revision: op.revision,
    row: {
      ...existing.row,
      phase: op.phase,
      turn: {
        ...existing.row.turn,
        timestamp:
          plausibleTurnStartMs(existing.row.turn.timestamp) !== null
            ? existing.row.turn.timestamp
            : assistantStartTimestamp(rows, op.row_id),
        blocks: mergePatchedBlocks(baseBlocks, op.blocks),
        usage: mergeReportedTurnUsage(existing.row.turn.usage, op.usage),
      },
    },
  };
  let nextLive = liveText;
  if (consumeOverlay) {
    nextLive = { ...liveText };
    delete nextLive[op.row_id];
  }
  return { rows: nextRows, liveText: nextLive };
}

function willAppendNewPatchedBlock(
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

function assistantStartTimestamp(
  rows: TimelineRow[],
  assistantRowId: string
): string {
  const pair = messageTurnPairKey(assistantRowId);
  if (pair) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (
        !row ||
        row.row.kind !== 'message_turn' ||
        row.row.turn.role !== 'user'
      ) {
        continue;
      }
      const userId = `${pair}:user`;
      if (row.row_id !== userId && row.row.turn.id !== userId) continue;
      if (plausibleTurnStartMs(row.row.turn.timestamp) !== null) {
        return row.row.turn.timestamp;
      }
    }
  }
  return new Date().toISOString();
}

function stubAssistantRow(
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  rows: TimelineRow[]
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
        timestamp: assistantStartTimestamp(rows, op.row_id),
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

function windowPrefixHash(detail: DbConversationDetail): string | null {
  const hash = (
    detail as DbConversationDetail & { prefix_hash?: string | null }
  ).prefix_hash;
  return hash ?? null;
}

function maxLiveRowRevision(rows: TimelineRow[]): bigint {
  let max = 0n;
  for (const row of rows) {
    if (!isLiveProjectorRowId(row.row_id)) continue;
    const revision = toBigInt(row.revision);
    if (revision > max) max = revision;
  }
  return max;
}

function hasPotentialStructuredToken(text: string): boolean {
  return text.includes('[');
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
  if (!hasPotentialStructuredToken(existingText)) {
    return incoming;
  }
  const incomingText = userTurnText(incoming.row.turn);
  if (
    getSessionComposerStructuredTokens(existingText).length === 0 ||
    (hasPotentialStructuredToken(incomingText) &&
      getSessionComposerStructuredTokens(incomingText).length > 0)
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

function preserveStructuredUserTextFromLiveRows(
  windowRows: TimelineRow[],
  liveRows: TimelineRow[]
): TimelineRow[] {
  if (windowRows.length === 0 || liveRows.length === 0) return windowRows;
  const liveUsers = liveRows.filter((row) => {
    if (row.row.kind !== 'message_turn' || row.row.turn.role !== 'user') {
      return false;
    }
    const text = userTurnText(row.row.turn);
    return (
      hasPotentialStructuredToken(text) &&
      getSessionComposerStructuredTokens(text).length > 0
    );
  });
  if (liveUsers.length === 0) return windowRows;
  return windowRows.map((row) => {
    if (row.row.kind !== 'message_turn' || row.row.turn.role !== 'user') {
      return row;
    }
    const windowTurn = row.row.turn;
    const match = liveUsers.find(
      (live) =>
        live.row.kind === 'message_turn' &&
        promptsMatch(userTurnText(live.row.turn), userTurnText(windowTurn))
    );
    return match ? preserveStructuredUserText(match, row) : row;
  });
}

function appendLiveText(
  liveText: Record<string, LiveTextOverlay>,
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  _currentTurnId: string | null,
  op: Extract<ConversationRowOp, { op: 'append_text' }>
): Record<string, LiveTextOverlay> {
  if (
    isLateSettledAssistantAppend(liveRows, op.row_id) ||
    isLateSettledAssistantAppend(windowRows, op.row_id)
  ) {
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

/**
 * Promote streaming live-id rows that were placed in `windowRows` via initial
 * `loaded(...)` in unit tests so a subsequent file-window `load_success` (`acp-*`)
 * treats them as part of `liveRows` until the file window converges.
 */
function promoteUnconvergedStreamingLiveRows(
  previousWindowRows: TimelineRow[],
  currentLiveRows: TimelineRow[],
  incomingWindowRows: TimelineRow[]
): TimelineRow[] {
  const incomingIds = new Set(incomingWindowRows.map((row) => row.row_id));
  const liveIds = new Set(currentLiveRows.map((row) => row.row_id));
  const activeLiveTurnKeys = new Set(
    currentLiveRows
      .map((row) => messageTurnPairKey(row.row_id))
      .filter((key): key is string => Boolean(key))
  );
  const promoted: TimelineRow[] = [];
  for (const row of previousWindowRows) {
    if (incomingIds.has(row.row_id) || liveIds.has(row.row_id)) continue;
    const turnKey = messageTurnPairKey(row.row_id);
    if (
      isLiveProjectorRowId(row.row_id) &&
      row.row.kind === 'message_turn' &&
      (row.row.phase === 'streaming' ||
        (turnKey !== null && activeLiveTurnKeys.has(turnKey)))
    ) {
      promoted.push(row);
    }
  }
  return promoted.length > 0
    ? [...promoted, ...currentLiveRows]
    : currentLiveRows;
}

/**
 * Clear live rows and overlays only after `windowRows` contains the converged
 * turn content. Never clear `liveRows` merely because `in_flight_user_turn_id`
 * is null when the window does not yet reflect the completed turn.
 */
function pruneConvergedLiveState(
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  keepRealtimeRows: boolean
): {
  liveRows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
} {
  if (keepRealtimeRows) {
    return { liveRows, liveText };
  }
  const turnKeys = new Set<string>();
  for (const row of liveRows) {
    const key = messageTurnPairKey(row.row_id);
    if (key) turnKeys.add(key);
  }
  for (const rowId of Object.keys(liveText)) {
    const key = messageTurnPairKey(rowId);
    if (key) turnKeys.add(key);
  }
  const windowSideRevisions = new Map<string, bigint>();
  for (const row of windowRows) {
    if (row.row.kind !== 'message_turn') {
      const baseId = row.row_id.split('|')[0] ?? row.row_id;
      windowSideRevisions.set(baseId, toBigInt(row.revision));
    }
  }
  const filteredSideLiveRows = liveRows.filter((row) => {
    if (row.row.kind === 'message_turn') return true;
    const baseId = row.row_id.split('|')[0] ?? row.row_id;
    const winRev = windowSideRevisions.get(baseId);
    return winRev === undefined || toBigInt(row.revision) > winRev;
  });
  if (turnKeys.size === 0) {
    return { liveRows: filteredSideLiveRows, liveText };
  }

  const convergedKeys = new Set<string>();
  for (const key of turnKeys) {
    if (isLiveTurnConvergedInWindow(key, windowRows, liveRows, liveText)) {
      convergedKeys.add(key);
    }
  }

  if (convergedKeys.size === 0) {
    return { liveRows: filteredSideLiveRows, liveText };
  }

  const nextLiveRows = filteredSideLiveRows.filter((row) => {
    const key = messageTurnPairKey(row.row_id);
    return !key || !convergedKeys.has(key);
  });
  const nextLiveText: Record<string, LiveTextOverlay> = {};
  for (const [rowId, overlay] of Object.entries(liveText)) {
    const key = messageTurnPairKey(rowId);
    if (!key || !convergedKeys.has(key)) {
      nextLiveText[rowId] = overlay;
    }
  }
  return { liveRows: nextLiveRows, liveText: nextLiveText };
}

function isLiveTurnConvergedInWindow(
  turnKey: string,
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): boolean {
  const turnRows = liveRows.filter(
    (row) => messageTurnPairKey(row.row_id) === turnKey
  );
  const liveUser = turnRows.find(
    (row) =>
      row.row.kind === 'message_turn' &&
      row.row.turn.role === 'user' &&
      !row.row_id.includes(':steer:')
  );
  const liveAssistants = turnRows.filter(
    (row) =>
      row.row.kind === 'message_turn' && row.row.turn.role === 'assistant'
  );
  const overlay = liveText[`${turnKey}:assistant`];

  // Find the matching round in `windowRows` (searching from the tail).
  let matchedUserIndex = -1;
  if (liveUser && liveUser.row.kind === 'message_turn') {
    const targetPrompt = userTurnText(liveUser.row.turn);
    for (let index = windowRows.length - 1; index >= 0; index -= 1) {
      const candidate = windowRows[index];
      if (
        candidate &&
        candidate.row.kind === 'message_turn' &&
        candidate.row.turn.role === 'user' &&
        !candidate.row_id.includes(':steer:') &&
        (candidate.row_id === liveUser.row_id ||
          promptsMatch(userTurnText(candidate.row.turn), targetPrompt))
      ) {
        matchedUserIndex = index;
        break;
      }
    }
    if (matchedUserIndex < 0) return false;
    const matchedUser = windowRows[matchedUserIndex];
    // A later send can repeat the finished prompt and, briefly, its answer.
    // The file stamp and the live stamp of one send stay within the skew;
    // a stamp past that is a new turn and must not be dropped.
    if (livePromptStartsAfterWindowUser(liveUser, matchedUser)) return false;
  } else {
    for (let index = windowRows.length - 1; index >= 0; index -= 1) {
      const candidate = windowRows[index];
      if (
        candidate &&
        candidate.row.kind === 'message_turn' &&
        candidate.row.turn.role === 'user' &&
        !candidate.row_id.includes(':steer:')
      ) {
        matchedUserIndex = index;
        break;
      }
    }
    if (matchedUserIndex < 0) return false;
  }

  // Collect the window rows in this round (from `matchedUserIndex` up to the next non-steer user turn).
  const roundRows: TimelineRow[] = [];
  for (let index = matchedUserIndex; index < windowRows.length; index += 1) {
    const row = windowRows[index];
    if (!row) continue;
    if (
      index > matchedUserIndex &&
      row.row.kind === 'message_turn' &&
      row.row.turn.role === 'user' &&
      !row.row_id.includes(':steer:')
    ) {
      break;
    }
    roundRows.push(row);
  }

  // An open streaming round in the window is not yet converged.
  if (
    roundRows.some(
      (row) => row.row.kind === 'message_turn' && row.row.phase === 'streaming'
    )
  ) {
    return false;
  }

  const windowAssistants = roundRows.filter(
    (row) =>
      row.row.kind === 'message_turn' && row.row.turn.role === 'assistant'
  );

  const hasLiveAssistantExpectation =
    liveAssistants.length > 0 ||
    Boolean(
      overlay && (overlay.text.length > 0 || overlay.reasoning.length > 0)
    );

  if (hasLiveAssistantExpectation) {
    if (windowAssistants.length === 0) return false;
    const windowBlocks = windowAssistants.flatMap((row) =>
      row.row.kind === 'message_turn' ? row.row.turn.blocks : []
    );
    const liveBaseBlocks = liveAssistants.flatMap((row) =>
      row.row.kind === 'message_turn' ? row.row.turn.blocks : []
    );
    const expectedBlocks = overlay
      ? overlayLiveText(liveBaseBlocks, overlay)
      : liveBaseBlocks;
    return windowBlocksCoverLiveBlocks(windowBlocks, expectedBlocks);
  }

  // Only a user row exists in liveRows. If it was still streaming and the window
  // round has no assistant yet, keep the live user only while it is streaming.
  if (
    liveUser &&
    liveUser.row.kind === 'message_turn' &&
    liveUser.row.phase === 'streaming' &&
    windowAssistants.length === 0
  ) {
    return false;
  }

  return true;
}

/** File prompt time and the live user event can disagree by a moment. */
const SAME_TURN_STAMP_SKEW_MS = 2_000;

function livePromptStartsAfterWindowUser(
  liveUser: TimelineRow | undefined,
  windowUser: TimelineRow | undefined
): boolean {
  if (
    !liveUser ||
    liveUser.row.kind !== 'message_turn' ||
    !windowUser ||
    windowUser.row.kind !== 'message_turn'
  ) {
    return false;
  }
  const liveMs = plausibleTurnStartMs(liveUser.row.turn.timestamp);
  const windowMs = plausibleTurnStartMs(windowUser.row.turn.timestamp);
  if (liveMs === null || windowMs === null) return false;
  return liveMs > windowMs + SAME_TURN_STAMP_SKEW_MS;
}

function windowBlocksCoverLiveBlocks(
  windowBlocks: ContentBlock[],
  liveBlocks: ContentBlock[]
): boolean {
  const windowText = windowBlocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  const liveText = liveBlocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  if (liveText.length > 0 && !windowText.includes(liveText)) {
    return false;
  }
  const windowToolIds = new Set(toolUseIdsOf(windowBlocks));
  for (const toolId of toolUseIdsOf(liveBlocks)) {
    if (!windowToolIds.has(toolId)) return false;
  }
  return true;
}

function promptsMatch(left: string, right: string): boolean {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed === rightTrimmed) return true;
  if (
    !hasPotentialStructuredToken(leftTrimmed) &&
    !hasPotentialStructuredToken(rightTrimmed)
  ) {
    return false;
  }
  return (
    serializeSessionComposerBackendMessage(leftTrimmed).trim() ===
    serializeSessionComposerBackendMessage(rightTrimmed).trim()
  );
}

type TrailingWindowRound = {
  startIndex: number;
  userRow: TimelineRow | null;
  assistantRows: TimelineRow[];
  isStreamingOrOpen: boolean;
};

function findTrailingWindowRound(
  windowRows: TimelineRow[]
): TrailingWindowRound | null {
  let lastMessageIndex = -1;
  for (let index = windowRows.length - 1; index >= 0; index -= 1) {
    if (windowRows[index]?.row.kind === 'message_turn') {
      lastMessageIndex = index;
      break;
    }
  }
  if (lastMessageIndex < 0) return null;

  const lastMessage = windowRows[lastMessageIndex]!;
  // Check for an orphan trailing streaming assistant (e.g. a file snapshot where
  // the streaming assistant arrived before a user prompt existed for that round).
  if (
    lastMessage.row.kind === 'message_turn' &&
    lastMessage.row.turn.role === 'assistant' &&
    lastMessage.row.phase === 'streaming'
  ) {
    let prevMessage: TimelineRow | null = null;
    for (let index = lastMessageIndex - 1; index >= 0; index -= 1) {
      if (windowRows[index]?.row.kind === 'message_turn') {
        prevMessage = windowRows[index]!;
        break;
      }
    }
    if (
      !prevMessage ||
      (prevMessage.row.kind === 'message_turn' &&
        prevMessage.row.turn.role !== 'user')
    ) {
      return {
        startIndex: lastMessageIndex,
        userRow: null,
        assistantRows: [lastMessage],
        isStreamingOrOpen: true,
      };
    }
  }

  let userIndex = -1;
  for (let index = lastMessageIndex; index >= 0; index -= 1) {
    const candidate = windowRows[index];
    if (
      candidate?.row.kind === 'message_turn' &&
      candidate.row.turn.role === 'user' &&
      !candidate.row_id.includes(':steer:')
    ) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  const userRow = windowRows[userIndex]!;
  const assistantRows: TimelineRow[] = [];
  for (let index = userIndex + 1; index < windowRows.length; index += 1) {
    const candidate = windowRows[index];
    if (
      candidate?.row.kind === 'message_turn' &&
      candidate.row.turn.role === 'assistant'
    ) {
      assistantRows.push(candidate);
    }
  }
  const isStreamingOrOpen =
    (userRow.row.kind === 'message_turn' &&
      userRow.row.phase === 'streaming') ||
    assistantRows.length === 0 ||
    assistantRows.some(
      (row) => row.row.kind === 'message_turn' && row.row.phase === 'streaming'
    );

  return {
    startIndex: userIndex,
    userRow,
    assistantRows,
    isStreamingOrOpen,
  };
}

/**
 * Render `windowRows` first, followed by `liveRows`.
 * Aligns the trailing round of `windowRows` with `liveRows` by turn position
 * and user-visible prompt text so `acp-N` and `{turn}:*` for the same turn
 * never appear together, while falling back to the window's open streaming
 * tail when `liveRows` is empty.
 */
function combineWindowAndLiveRows(
  conversationId: string,
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): TimelineRow[] {
  if (liveRows.length === 0) {
    return windowRows;
  }

  // 1. Replace any exact `row_id` matches in `windowRows` (e.g. unit tests that
  //    seeded `{turn}:*` rows via `load_success` and then updated them via `row_ops`).
  const baseRowId = (id: string) => id.split('|')[0] ?? id;
  const liveByRowId = new Map(
    liveRows.map((row) => [baseRowId(row.row_id), row])
  );
  const replacedIds = new Set<string>();
  let effectiveWindow = windowRows.map((row) => {
    const baseId = baseRowId(row.row_id);
    const replacement = liveByRowId.get(baseId);
    if (!replacement) return row;
    replacedIds.add(baseId);
    if (row.row_id.includes('|') && !replacement.row_id.includes('|')) {
      return toBigInt(replacement.revision) > toBigInt(row.revision)
        ? { ...replacement, row_id: row.row_id }
        : row;
    }
    return replacement;
  });
  let remainingLive = liveRows.filter(
    (row) => !replacedIds.has(baseRowId(row.row_id))
  );
  if (remainingLive.length === 0) {
    return dropSeededInitialPrompt(conversationId, effectiveWindow);
  }

  // 2. Align the trailing round of `effectiveWindow` with `remainingLive` by
  //    turn position (tail of `windowRows`) and user-visible prompt text.
  const trailing = findTrailingWindowRound(effectiveWindow);
  if (trailing) {
    const firstLiveUser = remainingLive.find(
      (row) => row.row.kind === 'message_turn' && row.row.turn.role === 'user'
    );
    const firstLiveAssistant = remainingLive.find(
      (row) =>
        row.row.kind === 'message_turn' && row.row.turn.role === 'assistant'
    );

    const trailingUserText =
      trailing.userRow?.row.kind === 'message_turn'
        ? userTurnText(trailing.userRow.row.turn)
        : null;
    const liveUserText =
      firstLiveUser?.row.kind === 'message_turn'
        ? userTurnText(firstLiveUser.row.turn)
        : null;

    const liveHasTerminalPhase = remainingLive.some(
      (row) =>
        row.row.kind === 'message_turn' &&
        TERMINAL_ROW_PHASES.has(row.row.phase)
    );

    const alignsByPrompt =
      trailingUserText !== null &&
      liveUserText !== null &&
      promptsMatch(trailingUserText, liveUserText) &&
      (trailing.isStreamingOrOpen || liveHasTerminalPhase);

    const alignsOrphanWindowAssistant =
      trailing.userRow === null &&
      trailing.isStreamingOrOpen &&
      Boolean(firstLiveUser || firstLiveAssistant);

    const alignsOrphanLiveAssistant =
      trailing.userRow !== null &&
      trailing.isStreamingOrOpen &&
      !firstLiveUser &&
      Boolean(firstLiveAssistant);

    if (
      alignsByPrompt ||
      alignsOrphanWindowAssistant ||
      alignsOrphanLiveAssistant
    ) {
      const windowAssistantBlocks = trailing.assistantRows.flatMap((row) =>
        row.row.kind === 'message_turn' ? row.row.turn.blocks : []
      );
      if (windowAssistantBlocks.length > 0 && firstLiveAssistant) {
        remainingLive = remainingLive.map((row) => {
          if (
            row.row_id !== firstLiveAssistant.row_id ||
            row.row.kind !== 'message_turn'
          ) {
            return row;
          }
          return {
            ...row,
            row: {
              ...row.row,
              turn: mergeAssistantTurnData(
                trailing.assistantRows[0]!.row.kind === 'message_turn'
                  ? {
                      ...trailing.assistantRows[0]!.row.turn,
                      blocks: windowAssistantBlocks,
                    }
                  : row.row.turn,
                row.row.turn
              ),
            },
          };
        });
      }

      if (alignsOrphanLiveAssistant && trailing.userRow) {
        // Keep the window's user row in front of the orphan live assistant,
        // suppressing only the window's trailing streaming assistant rows.
        const suppressedIds = new Set(
          trailing.assistantRows.map((row) => row.row_id)
        );
        effectiveWindow = effectiveWindow.filter(
          (row, index) =>
            index < trailing.startIndex || !suppressedIds.has(row.row_id)
        );
      } else {
        // Suppress the overlapping trailing round in `windowRows` (preserving any
        // non-message side rows in that tail slice).
        effectiveWindow = effectiveWindow.filter(
          (row, index) =>
            index < trailing.startIndex || row.row.kind !== 'message_turn'
        );
      }
    } else {
      const liveTurnKey = messageTurnPairKey(
        (firstLiveUser ?? firstLiveAssistant)?.row_id ?? ''
      );
      // The file round already finished and covers this live reply, but the
      // live row is still streaming, so prompt alignment does not apply.
      // Keep the settled window copy (it has the final duration and usage).
      if (
        liveTurnKey &&
        isLiveTurnConvergedInWindow(
          liveTurnKey,
          effectiveWindow,
          remainingLive,
          liveText
        )
      ) {
        remainingLive = remainingLive.filter(
          (row) => messageTurnPairKey(row.row_id) !== liveTurnKey
        );
      }
    }
  }

  // Also seed pre-reload assistant blocks from a suppressed trailing window
  // assistant when the live turn only has `{turn}:user` + `liveText` so far.
  if (trailing && trailing.assistantRows.length > 0) {
    const firstLiveUser = remainingLive.find(
      (row) => row.row.kind === 'message_turn' && row.row.turn.role === 'user'
    );
    const hasLiveAssistant = remainingLive.some(
      (row) =>
        row.row.kind === 'message_turn' && row.row.turn.role === 'assistant'
    );
    if (firstLiveUser && !hasLiveAssistant) {
      const turnKey = messageTurnPairKey(firstLiveUser.row_id);
      const assistantId = turnKey ? `${turnKey}:assistant` : null;
      const windowAssistant = trailing.assistantRows[0];
      if (
        assistantId &&
        windowAssistant &&
        windowAssistant.row.kind === 'message_turn' &&
        !effectiveWindow.some((row) => row.row_id === windowAssistant.row_id)
      ) {
        const overlay = liveText[assistantId];
        const blocks = overlay
          ? overlayLiveText(windowAssistant.row.turn.blocks, overlay)
          : windowAssistant.row.turn.blocks;
        remainingLive = insertTimelineRow(remainingLive, {
          row_id: assistantId,
          revision: overlay ? overlay.revision : windowAssistant.revision,
          row: {
            kind: 'message_turn',
            phase:
              firstLiveUser.row.kind === 'message_turn' &&
              TERMINAL_ROW_PHASES.has(firstLiveUser.row.phase)
                ? firstLiveUser.row.phase
                : 'streaming',
            turn: {
              ...windowAssistant.row.turn,
              id: assistantId,
              blocks,
            },
          },
        });
      }
    }
  }

  return dropSeededInitialPrompt(conversationId, [
    ...effectiveWindow,
    ...remainingLive,
  ]);
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
    if (!isLiveProjectorRowId(row.row_id)) return max;
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

const CLIENT_ASSISTANT_ID = /:assistant(?::\d+)?$/;

function isClientAssistantId(id: string): boolean {
  return CLIENT_ASSISTANT_ID.test(id);
}

function toolUseIdsOf(blocks: ContentBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === 'tool_use' && block.tool_use_id ? [block.tool_use_id] : []
  );
}

function mergeAssistantTurnData(
  fileTurn: MessageTurn,
  clientTurn: MessageTurn
): MessageTurn {
  const timestamp =
    plausibleTurnStartMs(fileTurn.timestamp) !== null
      ? fileTurn.timestamp
      : plausibleTurnStartMs(clientTurn.timestamp) !== null
        ? clientTurn.timestamp
        : fileTurn.timestamp || clientTurn.timestamp;
  return {
    ...clientTurn,
    timestamp,
    blocks: mergeAssistantBlocks(fileTurn.blocks, clientTurn.blocks),
    usage: mergeReportedTurnUsage(fileTurn.usage, clientTurn.usage),
    duration_ms: clientTurn.duration_ms ?? fileTurn.duration_ms,
    model: clientTurn.model ?? fileTurn.model,
  };
}

function mergeAssistantBlocks(
  fileBlocks: ContentBlock[],
  clientBlocks: ContentBlock[]
): ContentBlock[] {
  if (fileBlocks.length === 0) return clientBlocks;
  if (clientBlocks.length === 0) return fileBlocks;

  const fileHasStructured = fileBlocks.some(
    (block) =>
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'plan'
  );
  const clientHasStructured = clientBlocks.some(
    (block) =>
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'plan'
  );

  // Pure text / thinking on both sides: combine without duplicating prefix/suffix.
  if (!fileHasStructured && !clientHasStructured) {
    const fileThinking = fileBlocks
      .flatMap((b) => (b.type === 'thinking' ? [b.text] : []))
      .join('');
    const clientThinking = clientBlocks
      .flatMap((b) => (b.type === 'thinking' ? [b.text] : []))
      .join('');
    const fileText = fileBlocks
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('');
    const clientText = clientBlocks
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('');
    const merged: ContentBlock[] = [];
    const combinedThinking = mergeOverlayText(fileThinking, clientThinking);
    if (combinedThinking) {
      merged.push({ type: 'thinking', text: combinedThinking });
    }
    const combinedText = mergeOverlayText(fileText, clientText);
    if (combinedText) {
      merged.push({ type: 'text', text: combinedText });
    }
    return merged.length > 0 ? merged : clientBlocks;
  }

  // When `clientBlocks` starts at a mid-turn `patch_blocks` (so its first block
  // is a tool_use/plan without the pre-reload blocks that `fileBlocks` holds),
  // seed with the prefix of `fileBlocks` and fold `clientBlocks` on top.
  const firstClientBlock = clientBlocks[0];
  if (
    firstClientBlock &&
    (firstClientBlock.type === 'tool_use' ||
      firstClientBlock.type === 'tool_result' ||
      firstClientBlock.type === 'plan')
  ) {
    const matchIndex =
      firstClientBlock.type === 'tool_use' && firstClientBlock.tool_use_id
        ? fileBlocks.findIndex(
            (b) =>
              b.type === 'tool_use' &&
              b.tool_use_id === firstClientBlock.tool_use_id
          )
        : firstClientBlock.type === 'plan'
          ? fileBlocks.findIndex((b) => b.type === 'plan')
          : -1;
    const prefix =
      matchIndex >= 0 ? fileBlocks.slice(0, matchIndex) : fileBlocks.slice();
    return mergeBlockSequence(prefix, clientBlocks);
  }

  return mergeBlockSequence(fileBlocks, clientBlocks);
}

function mergeBlockSequence(
  baseBlocks: ContentBlock[],
  incomingBlocks: ContentBlock[]
): ContentBlock[] {
  const result = baseBlocks.slice();
  for (const block of incomingBlocks) {
    if (
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'plan'
    ) {
      const patched = mergePatchedBlocks(result, [block]);
      result.length = 0;
      result.push(...patched);
    } else if (block.type === 'text' || block.type === 'thinking') {
      mergeOverlayBlock(result, block.type, block.text);
    } else {
      result.push(block);
    }
  }
  return result;
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

const EPOCH_MILLIS_REVISION_FLOOR = 1_000_000_000_000n;

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
    const isEpochMillisMessage =
      !isLiveProjectorRowId(message.item.turn.id) &&
      message.revision >= EPOCH_MILLIS_REVISION_FLOOR &&
      maxSideRevision < EPOCH_MILLIS_REVISION_FLOOR;
    const isOptimisticOrZeroTrailing =
      message.item.phase === 'optimistic' ||
      (message.revision <= 0n &&
        (runningMaxRevision > 0n || maxSideRevision > 0n));
    const effectiveRevision = isOptimisticOrZeroTrailing
      ? (runningMaxRevision > maxSideRevision
          ? runningMaxRevision
          : maxSideRevision) + 1n
      : isEpochMillisMessage
        ? runningMaxRevision
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

export function selectConversationTimelineItems(
  state: ConversationStoreState,
  conversationId: string | null,
  shouldInline: (row: TimelineRow) => boolean = defaultInlineSideRow
): ConversationTimelineItem[] {
  if (!conversationId) return [];
  return timelineItemsForEntry(
    state.byConversationId[conversationId] ?? null,
    shouldInline
  );
}

export function defaultInlineSideRow(row: TimelineRow): boolean {
  return INLINE_SIDE_ROW_KINDS.has(row.row.kind);
}

function createEntry(conversationId: string): ConversationStoreEntry {
  return {
    conversationId,
    detail: null,
    windowRows: [],
    liveRows: [],
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
    prefixHash: null,
    userTurnsBeforeOffset: 0,
    loadedToStart: false,
    olderTurnsPrependEpoch: 0,
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
    const authoritativeBackendText = hasPotentialStructuredToken(
      authoritativeText
    )
      ? serializeSessionComposerBackendMessage(authoritativeText).trim()
      : authoritativeText.trim();
    optimisticIndex = optimisticTurns.findIndex((turn) => {
      const candidateText = userTurnText(turn);
      const candidateBackendText = hasPotentialStructuredToken(candidateText)
        ? serializeSessionComposerBackendMessage(candidateText).trim()
        : candidateText.trim();
      return candidateBackendText === authoritativeBackendText;
    });
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

/**
 * When a turn is in flight and the transcript ends on a user turn (`acp-N`,
 * before the first assistant chunk is written), mark that trailing user
 * turn `streaming` so `withPendingAssistantTurns` renders the waiting
 * assistant bubble.
 */
function settleIdleOpenTail(
  rows: TimelineRow[],
  turnInFlight: boolean
): TimelineRow[] {
  if (rows.length === 0 || !turnInFlight) return rows;
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  if (
    last &&
    last.row.kind === 'message_turn' &&
    last.row.turn.role === 'user' &&
    !isLiveProjectorRowId(last.row_id) &&
    last.row.phase !== 'streaming'
  ) {
    const next = rows.slice();
    next[lastIndex] = {
      ...last,
      row: { ...last.row, phase: 'streaming' },
    };
    return next;
  }
  return rows;
}

function isLiveProjectorRowId(rowId: string): boolean {
  return (
    rowId.endsWith(':user') ||
    /:assistant(?::\d+)?$/.test(rowId) ||
    rowId.includes(':steer:')
  );
}

/**
 * The first open of a new session can project `initial_prompt` as
 * `{conversationId}:user` before the live user row arrives. Drop that seed
 * once another user row carries the same text. Two real prompts that happen
 * to match stay, because neither uses the conversation id as its row id.
 */
function dropSeededInitialPrompt(
  conversationId: string,
  rows: TimelineRow[]
): TimelineRow[] {
  const seedId = `${conversationId}:user`;
  const seed = rows.find((row) => row.row_id === seedId);
  if (
    !seed ||
    seed.row.kind !== 'message_turn' ||
    seed.row.turn.role !== 'user'
  ) {
    return rows;
  }
  const seedText = userTurnText(seed.row.turn);
  const duplicated = rows.some(
    (row) =>
      row.row_id !== seedId &&
      row.row.kind === 'message_turn' &&
      row.row.turn.role === 'user' &&
      userTurnText(row.row.turn) === seedText
  );
  if (!duplicated) return rows;
  return rows.filter((row) => row.row_id !== seedId);
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
    let userTurn = result.find(
      (row) => row.turn.role === 'user' && row.turn.id === userId
    );
    if (!userTurn) {
      const lastRow = result[result.length - 1];
      if (lastRow && lastRow.turn.role === 'user') {
        userTurn = lastRow;
      }
    }
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
    const pendingUserIndex = result.findIndex(
      (row) => row.turn.id === pendingUser.turn.id
    );
    const hasFollowingAssistant =
      pendingUserIndex >= 0 &&
      result
        .slice(pendingUserIndex + 1)
        .some((row) => row.turn.role === 'assistant');
    const assistantId = pendingUser.turn.id.endsWith(':user')
      ? `${pendingUser.turn.id.slice(0, -':user'.length)}:assistant`
      : `${pendingUser.turn.id}:assistant`;
    const hasOrphanAssistant = result.some(
      (row) =>
        row.turn.role === 'assistant' &&
        isClientAssistantId(row.turn.id) &&
        !hasPairedUser(result, row.turn.id)
    );
    if (
      !assistantIds.has(assistantId) &&
      !hasFollowingAssistant &&
      !hasOrphanAssistant
    ) {
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
      if (hasPairedUser(result, candidate.turn.id)) return false;
      return true;
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
