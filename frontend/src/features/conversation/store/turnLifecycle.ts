import type {
  AgentAvailableCommand,
  AgentSessionConfigOption,
  AgentSessionControlsSnapshot,
  AgentSessionMode,
  AsyncTaskRecord,
  ContentBlock,
  ConversationRowOp,
  ConversationRowOpBatch,
  ConversationSessionGoal,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

import { getSessionComposerStructuredTokens } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { plausibleTurnStartMs } from '@/components/conversation-thread/turnClock';
import { mergeReportedTurnUsage } from '../reportedTurnUsage';
import {
  mergeOpenTimelineRows,
  preferLoadedOlderCursor,
} from '../timelinePaging';
import {
  TERMINAL_ROW_PHASES,
  combineWindowAndLiveRows,
  dropSeededInitialPrompt,
  hasPotentialStructuredToken,
  insertTimelineRow,
  isLateSettledAssistantAppend,
  isLiveProjectorRowId,
  isLiveTurnConvergedInWindow,
  mergePatchedBlocks,
  messageTurnPairKey,
  overlayLiveText,
  preserveStructuredUserText,
  promptsMatch,
  rebuildRowIndex,
  reconcileOptimisticTurnAgainstUserRow,
  reconcileOptimisticTurns,
  reconcileOptimisticTurnsAgainstRows,
  settleIdleOpenTail,
  toBigInt,
  userTurnText,
  windowBlocksCoverLiveBlocks,
} from './queue';

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
  /** Session goal snapshot and control actions (`_meta.goal` / AIR / `_meta.codex.goal`). */
  sessionGoal: ConversationSessionGoal | null;
  /** Live and settled background tasks (`asyncTasks` / Grok workflows). */
  asyncTasks: AsyncTaskRecord[];
  /** Latest ephemeral Composer prompt suggestion (`promptSuggestions`). */
  promptSuggestion: string | null;
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
  | { type: 'clear_prompt_suggestion'; conversationId: string }
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
        const consumedOptimistic =
          reconciledWindow.optimisticTurns.length <
          entry.optimisticTurns.length;
        const windowRows = preserveStructuredUserTextFromLiveRows(
          settleIdleOpenTail(
            dropSeededInitialPrompt(
              action.conversationId,
              reconciledWindow.rows
            ),
            Boolean(action.detail.in_flight_user_turn_id) || consumedOptimistic
          ),
          priorLiveRows
        );

        const prunedLive = pruneConvergedLiveState(
          windowRows,
          priorLiveRows,
          entry.liveText
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
          gap: { kind: 'none' } satisfies ConversationGapState,
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
          sessionGoal:
            action.detail.session_goal !== undefined &&
            action.detail.session_goal !== null
              ? action.detail.session_goal
              : entry.sessionGoal,
          asyncTasks:
            action.detail.async_tasks && action.detail.async_tasks.length > 0
              ? action.detail.async_tasks
              : entry.asyncTasks,
          promptSuggestion:
            action.detail.prompt_suggestion !== undefined &&
            action.detail.prompt_suggestion !== null
              ? action.detail.prompt_suggestion
              : entry.promptSuggestion,
          olderCursor: keepRealtimeRows
            ? preferLoadedOlderCursor(
                entry.olderCursor,
                action.detail.timeline.older_cursor,
                entry.windowRows.length > 0
              )
            : (action.detail.timeline.older_cursor ?? null),
          prefixHash: keepRealtimeRows
            ? preferLoadedOlderCursor(
                entry.olderCursor,
                action.detail.timeline.older_cursor,
                entry.windowRows.length > 0
              ) === (action.detail.timeline.older_cursor ?? null)
              ? (windowPrefixHash(action.detail) ?? entry.prefixHash)
              : entry.prefixHash
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
        sessionGoal:
          action.controls.goal !== undefined ||
          action.controls.goal_actions !== undefined
            ? {
                goal:
                  action.controls.goal !== undefined
                    ? action.controls.goal
                    : (entry.sessionGoal?.goal ?? null),
                actions:
                  action.controls.goal_actions !== undefined
                    ? action.controls.goal_actions
                    : (entry.sessionGoal?.actions ?? null),
              }
            : entry.sessionGoal,
        asyncTasks:
          action.controls.async_tasks && action.controls.async_tasks.length > 0
            ? action.controls.async_tasks
            : entry.asyncTasks,
        promptSuggestion:
          action.controls.prompt_suggestion !== undefined
            ? (action.controls.prompt_suggestion ?? null)
            : entry.promptSuggestion,
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
            if (!existing.has(row.row_id)) {
              older.push(row);
              existing.add(row.row_id);
              prepended += 1;
              if (
                row.row.kind === 'message_turn' &&
                row.row.turn.role === 'user' &&
                !row.row_id.includes(':steer:')
              ) {
                prependedUserTurns += 1;
              }
            } else {
              updates.push(row);
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
        const nextOlderCursor =
          action.olderCursor !== undefined
            ? action.olderCursor
            : entry.olderCursor;
        const nextLoadedToStart =
          entry.loadedToStart ||
          (action.olderCursor !== undefined && action.olderCursor == null);
        const windowStartChanged =
          nextOlderCursor !== entry.olderCursor ||
          nextLoadedToStart !== entry.loadedToStart;
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
          olderCursor: nextOlderCursor,
          prefixHash: windowStartChanged ? null : entry.prefixHash,
          userTurnsBeforeOffset: Math.max(
            0,
            entry.userTurnsBeforeOffset - prependedUserTurns
          ),
          olderTurnsPrependEpoch:
            entry.olderTurnsPrependEpoch + (prepended > 0 ? 1 : 0),
          loadedToStart: nextLoadedToStart,
          gap: { kind: 'none' },
        };
      });
    case 'optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: [...entry.optimisticTurns, action.turn],
        promptSuggestion: null,
      }));
    case 'remove_optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: entry.optimisticTurns.filter(
          (turn) => turn.id !== action.turnId
        ),
      }));
    case 'clear_prompt_suggestion':
      return updateEntry(state, action.conversationId, (entry) =>
        entry.promptSuggestion === null
          ? entry
          : {
              ...entry,
              promptSuggestion: null,
            }
      );
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
  let sawUserTurnUpsert = false;
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
        sawUserTurnUpsert = true;
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

  let rows: TimelineRow[];
  if (windowRows === entry.windowRows && liveRows === entry.liveRows) {
    rows = entry.rows;
  } else {
    liveRows = dropSeededInitialPrompt(entry.conversationId, liveRows);
    windowRows = dropSeededInitialPrompt(entry.conversationId, windowRows);
    rows = combineWindowAndLiveRows(
      entry.conversationId,
      windowRows,
      liveRows,
      liveText
    );
  }

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
    sessionGoal: batch.session_goal
      ? {
          goal:
            batch.session_goal.goal !== undefined
              ? batch.session_goal.goal
              : null,
          actions:
            batch.session_goal.actions !== undefined &&
            batch.session_goal.actions !== null
              ? batch.session_goal.actions
              : (entry.sessionGoal?.actions ?? null),
        }
      : entry.sessionGoal,
    asyncTasks: batch.async_tasks ?? entry.asyncTasks,
    promptSuggestion:
      batch.prompt_suggestion != null
        ? (batch.prompt_suggestion.suggestion ?? null)
        : sawUserTurnUpsert
          ? null
          : entry.promptSuggestion,
  };
}

function isTerminalMessageRow(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' && TERMINAL_ROW_PHASES.has(row.row.phase)
  );
}

function isNonTerminalMessageRow(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' && !TERMINAL_ROW_PHASES.has(row.row.phase)
  );
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
  let terminalConverged = false;
  if (index === undefined || index === -1) {
    const windowExisting = windowRows?.find(
      (row) => row.row_id === incoming.row_id
    );
    const isWindowTerminalTransition = Boolean(
      windowExisting &&
        isTerminalMessageRow(incoming) &&
        isNonTerminalMessageRow(windowExisting)
    );
    if (
      windowExisting &&
      incomingRevision < toBigInt(windowExisting.revision) &&
      !isWindowTerminalTransition
    ) {
      return { rows, liveText };
    }
    const isOverlayTerminalTransition = Boolean(
      !windowExisting &&
        liveText[incoming.row_id] &&
        isTerminalMessageRow(incoming)
    );
    const seededIncoming = windowExisting
      ? preserveAssistantBlocksOnColdUpsert(
          windowExisting,
          preserveStructuredUserText(windowExisting, incoming),
          liveText[incoming.row_id],
          isWindowTerminalTransition
        )
      : preserveAssistantBlocksOnColdUpsert(
          incoming,
          incoming,
          liveText[incoming.row_id],
          isOverlayTerminalTransition
        );
    nextRows = insertTimelineRow(rows, seededIncoming);
    rebuildRowIndex(nextRows, rowIndexById);
    applied = true;
    terminalConverged =
      isWindowTerminalTransition || isOverlayTerminalTransition;
  } else {
    const existing = rows[index]!;
    const isTerminalTransition =
      isTerminalMessageRow(incoming) && isNonTerminalMessageRow(existing);
    if (
      incomingRevision >= toBigInt(existing.revision) ||
      isTerminalTransition
    ) {
      const mergedIncoming = preserveAssistantBlocksOnColdUpsert(
        existing,
        preserveStructuredUserText(existing, incoming),
        liveText[incoming.row_id],
        isTerminalTransition
      );
      nextRows = rows.slice();
      nextRows[index] =
        isTerminalTransition && incomingRevision < toBigInt(existing.revision)
          ? { ...mergedIncoming, revision: existing.revision }
          : mergedIncoming;
      applied = true;
      terminalConverged = isTerminalTransition;
    }
  }
  // Drop the streaming overlay only when we actually applied a row whose revision is at
  // least the overlay's — that row already folds in every text delta up to its revision.
  // A rejected (stale) upsert, or one whose revision is *behind* the overlay (a late /
  // reordered duplicate), must NOT clear the overlay, or its newer streamed text would
  // vanish until the next real event re-upserts the row (丢字).
  let nextLive = liveText;
  const overlay = liveText[incoming.row_id];
  if (
    applied &&
    overlay &&
    (incomingRevision >= overlay.revision || terminalConverged)
  ) {
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
  overlay: LiveTextOverlay | undefined,
  forceApplyOverlay = false
): TimelineRow {
  if (
    existing.row.kind !== 'message_turn' ||
    existing.row.turn.role !== 'assistant' ||
    incoming.row.kind !== 'message_turn' ||
    incoming.row.turn.role !== 'assistant'
  ) {
    return incoming;
  }
  const incomingRevision = toBigInt(incoming.revision);
  const baseBlocks =
    overlay && (incomingRevision >= overlay.revision || forceApplyOverlay)
      ? overlayLiveText(existing.row.turn.blocks, overlay)
      : existing.row.turn.blocks;
  if (baseBlocks.length === 0) {
    return incoming;
  }
  if (
    incoming.row.turn.blocks.length > 0 &&
    windowBlocksCoverLiveBlocks(incoming.row.turn.blocks, baseBlocks)
  ) {
    return withMergedTurnUsage(existing, incoming);
  }
  const mergedBlocks =
    incoming.row.turn.blocks.length > 0
      ? mergePatchedBlocks(baseBlocks, incoming.row.turn.blocks)
      : baseBlocks;
  return {
    ...incoming,
    row: {
      ...incoming.row,
      turn: {
        ...incoming.row.turn,
        blocks: mergedBlocks,
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
              plausibleTurnStartMs(windowExisting.row.turn.timestamp) !== null
                ? windowExisting.row.turn.timestamp
                : assistantStartTimestamp(
                    windowRows ? [...windowRows, ...rows] : rows,
                    op.row_id
                  ),
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
      windowRows ? [...windowRows, ...rows] : rows
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
            : assistantStartTimestamp(
                windowRows ? [...windowRows, ...rows] : rows,
                op.row_id
              ),
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
  liveText: Record<string, LiveTextOverlay>
): {
  liveRows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
} {
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
    sessionGoal: null,
    asyncTasks: [],
    promptSuggestion: null,
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
