import type {
  AgentAvailableCommand,
  AgentSessionConfigOption,
  AgentSessionControlsSnapshot,
  AgentSessionMode,
  AsyncTaskRecord,
  ConversationRowOp,
  ConversationRowOpBatch,
  ConversationSessionGoal,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

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
  insertTimelineRow,
  mergeAssistantBlocks,
  mergePatchedBlocks,
  overlayLiveText,
  preserveStructuredUserText,
  preserveStructuredUserTextFromLiveRows,
  pruneConvergedLiveState,
  rebuildRowIndex,
  reconcileOptimisticTurnAgainstUserRow,
  reconcileOptimisticTurns,
  reconcileOptimisticTurnsAgainstRows,
  settleIdleOpenTail,
  toBigInt,
} from './queue';
import {
  appendLiveText,
  applyDeleteTombstone,
  assistantStartTimestamp,
  buildSettledAssistantRowIds,
  collectUserRowIds,
  detectSequenceGap,
  extendOptimisticBaselines,
  extractCurrentTurnStartedAt,
  isNonTerminalMessageRow,
  isOverlayAheadOfRevision,
  isSettledAssistantRow,
  isTerminalMessageRow,
  markSettledAssistantRow,
  maxLiveRowRevision,
  normalizeAgentIdentity,
  opRevision,
  overlayRevisionHorizon,
  pruneOptimisticBaselines,
  retainStreamingLiveText,
  selectActiveTurnStartedAt,
  stubAssistantRow,
  syncSettledAssistantRowId,
  turnIdOfRowId,
  willAppendNewPatchedBlock,
  windowPrefixHash,
} from './turnLifecycleHelpers';

export { normalizeAgentIdentity, selectActiveTurnStartedAt };

/**
 * Single-authority conversation store (SQLite `timeline_rows` + live `row_ops`).
 *
 * The backend projector is the sole projection authority. The frontend only:
 *   - stores SQLite window pages (`windowRows`) and live incremental updates (`liveRows`)
 *     under shared canonical `row_id`s, governed strictly by monotonic `revision`,
 *   - accumulates streaming deltas into a per-row `liveText` overlay, and
 *   - applies `Delete` tombstones and `reset: true` resync signals deterministically.
 */

export type ResettableConversationRowOpBatch = ConversationRowOpBatch & {
  reset?: boolean;
};

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
  /** Highest unconsuming patch revision (e.g. usage-only patch) covering this overlay. */
  patchedRevision?: bigint;
};

export type ConversationStoreEntry = {
  conversationId: string;
  detail: DbConversationDetail | null;
  /** Persisted window rows from `conversation_detail` and older keyset pagination. */
  windowRows: TimelineRow[];
  /** Live incremental rows from `row_ops` (`{turn}:user`, `{turn}:assistant`, steer, side rows). */
  liveRows: TimelineRow[];
  /** Combined rendered rows (`windowRows` merged with `liveRows` by canonical `row_id` and `revision`). */
  rows: TimelineRow[];
  /** Per-row streaming-text overlay (`row_id` → chunks since last upsert). */
  liveText: Record<string, LiveTextOverlay>;
  /** Indexed `:assistant` row IDs already in a terminal phase for O(1) append_text skip. */
  settledAssistantRowIds: Record<string, true>;
  lastSequence: bigint;
  /** Highest authoritative SQLite snapshot/backfill sequence applied (`load_success` / `apply_gap_rows`). */
  loadedLastSequence: bigint;
  projectionVersion: number | null;
  currentTurnId: string | null;
  loading: boolean;
  error: string | null;
  gap: ConversationGapState;
  optimisticTurns: MessageTurn[];
  /** User `row_id`s that already existed when each optimistic turn was queued, for deterministic causality. */
  optimisticBaselineUserRowIds: Record<string, string[]>;
  // Agent-advertised session controls (delivered alongside row-op batches). Drive the
  // composer's mode/config picker; empty until the agent advertises them.
  controlsAgentId: string | null;
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
      forceReplaceWindow?: boolean;
    }
  | { type: 'load_error'; conversationId: string; error: string | null }
  | {
      type: 'session_controls_hydrated';
      conversationId: string;
      controls: AgentSessionControlsSnapshot;
    }
  | { type: 'row_ops'; batch: ResettableConversationRowOpBatch }
  | {
      type: 'apply_gap_rows';
      conversationId: string;
      ops: ConversationRowOp[];
      lastSequence: bigint;
    }
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
        const forceReplace = Boolean(action.forceReplaceWindow);
        const keepRealtimeRows =
          !forceReplace && entry.lastSequence > detailLastSequence;
        const incomingRows = action.detail.timeline.rows;
        const priorLiveRows = forceReplace ? [] : entry.liveRows;
        const priorLiveText = forceReplace ? {} : entry.liveText;

        const incomingIds = new Set(incomingRows.map((row) => row.row_id));
        const baseWindowRows =
          keepRealtimeRows &&
          entry.windowRows.length > 0 &&
          entry.windowRows.some((row) => incomingIds.has(row.row_id))
            ? mergeOpenTimelineRows(entry.windowRows, incomingRows)
            : incomingRows;
        const droppedWindowSeed = dropSeededInitialPrompt(
          action.conversationId,
          baseWindowRows,
          entry.optimisticTurns
        );
        const reconciledWindow = reconcileOptimisticTurnsAgainstRows(
          entry.optimisticTurns,
          droppedWindowSeed,
          entry.optimisticBaselineUserRowIds,
          action.conversationId
        );
        const consumedOptimistic =
          reconciledWindow.optimisticTurns.length <
          entry.optimisticTurns.length;
        const windowRows = preserveStructuredUserTextFromLiveRows(
          settleIdleOpenTail(
            dropSeededInitialPrompt(
              action.conversationId,
              reconciledWindow.rows,
              reconciledWindow.optimisticTurns
            ),
            Boolean(action.detail.in_flight_user_turn_id) || consumedOptimistic,
            action.conversationId
          ),
          forceReplace ? [] : [...entry.windowRows, ...priorLiveRows]
        );

        const prunedLive = pruneConvergedLiveState(
          windowRows,
          priorLiveRows,
          priorLiveText
        );
        const nextOptimisticTurns = keepRealtimeRows
          ? reconcileOptimisticTurns(
              entry.optimisticTurns,
              action.detail.timeline,
              entry.optimisticBaselineUserRowIds,
              action.conversationId
            )
          : reconciledWindow.optimisticTurns;
        const liveRows = dropSeededInitialPrompt(
          action.conversationId,
          prunedLive.liveRows,
          nextOptimisticTurns
        );
        const liveText = retainStreamingLiveText(
          windowRows,
          liveRows,
          prunedLive.liveText
        );
        const settledAssistantRowIds = buildSettledAssistantRowIds(
          windowRows,
          liveRows
        );
        const rows = combineWindowAndLiveRows(
          action.conversationId,
          windowRows,
          liveRows,
          liveText
        );
        const optimisticBaselineUserRowIds = pruneOptimisticBaselines(
          entry.optimisticBaselineUserRowIds,
          nextOptimisticTurns
        );

        // `rows` is the timeline the view renders. Keeping the same rows on
        // `detail` duplicated the open window for as long as the card was mounted.
        const detail = {
          ...action.detail,
          timeline: { ...action.detail.timeline, rows: [] },
        };
        const detailAgentId = normalizeAgentIdentity(
          action.detail.summary.agent_id ??
            action.detail.active_binding?.agent_type ??
            null
        );
        const agentChanged = Boolean(
          detailAgentId &&
            entry.controlsAgentId &&
            detailAgentId !== entry.controlsAgentId
        );
        const nextSessionModes = action.detail.session_modes
          ? {
              current: action.detail.session_modes.current ?? null,
              modes: action.detail.session_modes.modes,
            }
          : agentChanged
            ? { current: null, modes: [] }
            : entry.sessionModes;
        const nextSessionConfigOptions =
          action.detail.session_config_options &&
          action.detail.session_config_options.length > 0
            ? action.detail.session_config_options
            : agentChanged
              ? []
              : entry.sessionConfigOptions;
        const nextAvailableCommands =
          action.detail.available_commands !== undefined &&
          action.detail.available_commands !== null
            ? action.detail.available_commands
            : agentChanged
              ? null
              : entry.availableCommands;
        const hasAnyControls =
          nextSessionModes.modes.length > 0 ||
          Boolean(nextSessionModes.current) ||
          nextSessionConfigOptions.length > 0;
        return {
          ...entry,
          detail,
          windowRows,
          liveRows,
          rows,
          liveText,
          settledAssistantRowIds,
          lastSequence: keepRealtimeRows
            ? entry.lastSequence
            : detailLastSequence,
          loadedLastSequence: forceReplace
            ? detailLastSequence
            : detailLastSequence > entry.loadedLastSequence
              ? detailLastSequence
              : entry.loadedLastSequence,
          projectionVersion: action.detail.projection_version,
          currentTurnId: action.detail.current_turn?.id ?? entry.currentTurnId,
          loading: false,
          error: null,
          gap: { kind: 'none' } satisfies ConversationGapState,
          optimisticTurns: nextOptimisticTurns,
          optimisticBaselineUserRowIds,
          // Hydrate agent-advertised session controls from the persisted event
          // log so a reopened conversation renders real ACP pickers immediately;
          // live row-op batches keep them fresh afterwards.
          controlsAgentId:
            detailAgentId ?? (hasAnyControls ? entry.controlsAgentId : null),
          sessionModes: nextSessionModes,
          sessionConfigOptions: nextSessionConfigOptions,
          availableCommands: nextAvailableCommands,
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
      return updateEntry(state, action.conversationId, (entry) => {
        const entryAgentId =
          normalizeAgentIdentity(
            entry.detail?.summary.agent_id ??
              entry.detail?.active_binding?.agent_type ??
              null
          ) ?? entry.controlsAgentId;
        const agentChanged = Boolean(
          entryAgentId &&
            entry.controlsAgentId &&
            entryAgentId !== entry.controlsAgentId
        );
        return {
          ...entry,
          controlsAgentId: entryAgentId,
          sessionModes:
            action.controls.modes.length > 0 || action.controls.current_mode
              ? {
                  current: action.controls.current_mode ?? null,
                  modes: action.controls.modes,
                }
              : agentChanged
                ? { current: null, modes: [] }
                : entry.sessionModes,
          sessionConfigOptions:
            action.controls.config_options.length > 0
              ? action.controls.config_options
              : agentChanged
                ? []
                : entry.sessionConfigOptions,
          availableCommands:
            action.controls.available_commands ??
            (agentChanged ? null : entry.availableCommands),
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
            action.controls.async_tasks &&
            action.controls.async_tasks.length > 0
              ? action.controls.async_tasks
              : entry.asyncTasks,
          promptSuggestion:
            action.controls.prompt_suggestion !== undefined
              ? (action.controls.prompt_suggestion ?? null)
              : entry.promptSuggestion,
        };
      });
    case 'row_ops': {
      return updateEntry(state, action.batch.conversation_id, (entry) => {
        return applyRowOpBatch(entry, action.batch);
      });
    }
    case 'apply_gap_rows':
      return updateEntry(state, action.conversationId, (entry) =>
        applyGapRows(entry, action.ops, action.lastSequence)
      );
    case 'upsert_rows':
      return updateEntry(state, action.conversationId, (entry) => {
        let windowRows = entry.windowRows;
        let liveRows = entry.liveRows;
        let liveText = entry.liveText;
        let settledAssistantRowIds = entry.settledAssistantRowIds;
        let optimisticTurns = entry.optimisticTurns;
        let optimisticBaselineUserRowIds = entry.optimisticBaselineUserRowIds;
        let prepended = 0;
        let prependedUserTurns = 0;
        if (action.protectLoaded) {
          const existing = new Set(windowRows.map((row) => row.row_id));
          const older: TimelineRow[] = [];
          const updates: TimelineRow[] = [];
          const olderUserRowIds: string[] = [];
          for (const row of action.rows) {
            if (!existing.has(row.row_id)) {
              older.push(row);
              existing.add(row.row_id);
              prepended += 1;
              if (
                row.row.kind === 'message_turn' &&
                row.row.turn.role === 'user'
              ) {
                olderUserRowIds.push(row.row_id);
                if (!row.row_id.includes(':steer:')) {
                  prependedUserTurns += 1;
                }
              }
            } else {
              updates.push(row);
            }
          }
          if (olderUserRowIds.length > 0 && optimisticTurns.length > 0) {
            optimisticBaselineUserRowIds = extendOptimisticBaselines(
              optimisticBaselineUserRowIds,
              optimisticTurns,
              olderUserRowIds
            );
          }
          windowRows = [...older, ...windowRows];
          for (const row of older) {
            if (isSettledAssistantRow(row)) {
              settledAssistantRowIds = markSettledAssistantRow(
                settledAssistantRowIds,
                row.row_id
              );
            }
          }
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
              if (applied.applied) {
                if (isSettledAssistantRow(row)) {
                  settledAssistantRowIds = markSettledAssistantRow(
                    settledAssistantRowIds,
                    row.row_id
                  );
                } else if (settledAssistantRowIds[row.row_id]) {
                  settledAssistantRowIds = syncSettledAssistantRowId(
                    settledAssistantRowIds,
                    row.row_id,
                    windowRows,
                    liveRows
                  );
                }
              }
            }
          }
          windowRows = dropSeededInitialPrompt(
            action.conversationId,
            windowRows,
            optimisticTurns
          );
        } else {
          const rowIndexById = new Map(
            liveRows.map((row, index) => [row.row_id, index] as const)
          );
          for (const row of action.rows) {
            const reconciled = reconcileOptimisticTurnAgainstUserRow(
              optimisticTurns,
              row,
              optimisticBaselineUserRowIds,
              action.conversationId
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
            if (applied.applied) {
              if (isSettledAssistantRow(reconciled.row)) {
                settledAssistantRowIds = markSettledAssistantRow(
                  settledAssistantRowIds,
                  reconciled.row.row_id
                );
              } else if (settledAssistantRowIds[reconciled.row.row_id]) {
                settledAssistantRowIds = syncSettledAssistantRowId(
                  settledAssistantRowIds,
                  reconciled.row.row_id,
                  windowRows,
                  liveRows
                );
              }
            }
          }
          optimisticBaselineUserRowIds = pruneOptimisticBaselines(
            optimisticBaselineUserRowIds,
            optimisticTurns
          );
          liveRows = dropSeededInitialPrompt(
            action.conversationId,
            liveRows,
            optimisticTurns
          );
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
        const incomingLastSeq = toBigInt(action.lastSequence);
        return {
          ...entry,
          windowRows,
          liveRows,
          rows,
          liveText,
          settledAssistantRowIds,
          optimisticTurns,
          optimisticBaselineUserRowIds,
          lastSequence:
            incomingLastSeq > entry.lastSequence
              ? incomingLastSeq
              : entry.lastSequence,
          loadedLastSequence:
            !action.protectLoaded && incomingLastSeq > entry.loadedLastSequence
              ? incomingLastSeq
              : entry.loadedLastSequence,
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
      return updateEntry(state, action.conversationId, (entry) => {
        const optimisticTurns = [...entry.optimisticTurns, action.turn];
        const windowRows = dropSeededInitialPrompt(
          action.conversationId,
          entry.windowRows,
          optimisticTurns
        );
        const liveRows = dropSeededInitialPrompt(
          action.conversationId,
          entry.liveRows,
          optimisticTurns
        );
        const rows =
          windowRows === entry.windowRows && liveRows === entry.liveRows
            ? entry.rows
            : combineWindowAndLiveRows(
                action.conversationId,
                windowRows,
                liveRows,
                entry.liveText
              );
        return {
          ...entry,
          error: null,
          windowRows,
          liveRows,
          rows,
          optimisticTurns,
          optimisticBaselineUserRowIds: {
            ...entry.optimisticBaselineUserRowIds,
            [action.turn.id]: collectUserRowIds(windowRows, liveRows),
          },
          promptSuggestion: null,
        };
      });
    case 'remove_optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => {
        const optimisticTurns = entry.optimisticTurns.filter(
          (turn) => turn.id !== action.turnId
        );
        return {
          ...entry,
          optimisticTurns,
          optimisticBaselineUserRowIds: pruneOptimisticBaselines(
            entry.optimisticBaselineUserRowIds,
            optimisticTurns
          ),
        };
      });
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

function applyOpsSequence(
  initial: {
    conversationId?: string;
    windowRows: TimelineRow[];
    liveRows: TimelineRow[];
    liveText: Record<string, LiveTextOverlay>;
    settledAssistantRowIds: Record<string, true>;
    currentTurnId: string | null;
    optimisticTurns: MessageTurn[];
    optimisticBaselineUserRowIds: Record<string, string[]>;
    fallbackTurnStartedAt?: string | null;
  },
  ops: ConversationRowOp[],
  loadedWatermark: bigint
): {
  windowRows: TimelineRow[];
  liveRows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
  settledAssistantRowIds: Record<string, true>;
  currentTurnId: string | null;
  optimisticTurns: MessageTurn[];
  sawUserTurnUpsert: boolean;
} {
  let {
    windowRows,
    liveRows,
    liveText,
    settledAssistantRowIds,
    currentTurnId,
    optimisticTurns,
  } = initial;
  let sawUserTurnUpsert = false;
  const rowIndexById = new Map(
    liveRows.map((row, index) => [row.row_id, index] as const)
  );
  for (const op of ops) {
    if (loadedWatermark > 0n && opRevision(op) <= loadedWatermark) {
      continue;
    }
    if (op.op === 'upsert') {
      const reconciled = reconcileOptimisticTurnAgainstUserRow(
        optimisticTurns,
        op.row,
        initial.optimisticBaselineUserRowIds,
        initial.conversationId
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
      if (applied.applied) {
        if (isSettledAssistantRow(reconciled.row)) {
          settledAssistantRowIds = markSettledAssistantRow(
            settledAssistantRowIds,
            reconciled.row.row_id
          );
        } else if (settledAssistantRowIds[reconciled.row.row_id]) {
          settledAssistantRowIds = syncSettledAssistantRowId(
            settledAssistantRowIds,
            reconciled.row.row_id,
            windowRows,
            liveRows
          );
        }
      }
      if (
        op.row.row.kind === 'message_turn' &&
        op.row.row.turn.role === 'user' &&
        op.row.row_id !== `${initial.conversationId}:user`
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
        windowRows,
        initial.conversationId,
        initial.fallbackTurnStartedAt
      );
      if (applied.rows !== liveRows) {
        liveRows = applied.rows;
        if (
          op.row_id.endsWith(':assistant') &&
          TERMINAL_ROW_PHASES.has(op.phase)
        ) {
          settledAssistantRowIds = markSettledAssistantRow(
            settledAssistantRowIds,
            op.row_id
          );
        } else if (settledAssistantRowIds[op.row_id]) {
          settledAssistantRowIds = syncSettledAssistantRowId(
            settledAssistantRowIds,
            op.row_id,
            windowRows,
            liveRows
          );
        }
      }
      liveText = applied.liveText;
    } else if (op.op === 'delete') {
      const deleted = applyDeleteTombstone(
        windowRows,
        liveRows,
        liveText,
        op.row_id,
        toBigInt(op.revision),
        rowIndexById
      );
      windowRows = deleted.windowRows;
      liveRows = deleted.liveRows;
      liveText = deleted.liveText;
      if (settledAssistantRowIds[op.row_id]) {
        settledAssistantRowIds = syncSettledAssistantRowId(
          settledAssistantRowIds,
          op.row_id,
          windowRows,
          liveRows
        );
      }
    } else {
      liveText = appendLiveText(liveText, settledAssistantRowIds, op);
    }
  }
  return {
    windowRows,
    liveRows,
    liveText,
    settledAssistantRowIds,
    currentTurnId,
    optimisticTurns,
    sawUserTurnUpsert,
  };
}

function applyGapRows(
  entry: ConversationStoreEntry,
  ops: ConversationRowOp[],
  incomingLastSequence: bigint
): ConversationStoreEntry {
  const applied = applyOpsSequence(
    {
      ...entry,
      fallbackTurnStartedAt: extractCurrentTurnStartedAt(entry.detail),
    },
    ops,
    0n
  );
  const optimisticBaselineUserRowIds = pruneOptimisticBaselines(
    entry.optimisticBaselineUserRowIds,
    applied.optimisticTurns
  );
  const windowRows = dropSeededInitialPrompt(
    entry.conversationId,
    applied.windowRows,
    applied.optimisticTurns
  );
  const prunedLive = pruneConvergedLiveState(
    windowRows,
    applied.liveRows,
    applied.liveText
  );
  const liveRows = dropSeededInitialPrompt(
    entry.conversationId,
    prunedLive.liveRows,
    applied.optimisticTurns
  );
  const liveText = retainStreamingLiveText(
    windowRows,
    liveRows,
    prunedLive.liveText
  );
  const settledAssistantRowIds = buildSettledAssistantRowIds(
    windowRows,
    liveRows
  );
  const rows = combineWindowAndLiveRows(
    entry.conversationId,
    windowRows,
    liveRows,
    liveText
  );
  const nextSeq = toBigInt(incomingLastSequence);

  return {
    ...entry,
    windowRows,
    liveRows,
    rows,
    liveText,
    settledAssistantRowIds,
    currentTurnId: applied.currentTurnId,
    optimisticTurns: applied.optimisticTurns,
    optimisticBaselineUserRowIds,
    lastSequence: nextSeq > entry.lastSequence ? nextSeq : entry.lastSequence,
    loadedLastSequence:
      nextSeq > entry.loadedLastSequence ? nextSeq : entry.loadedLastSequence,
    gap: { kind: 'none' },
  };
}

function applyBatchMetadata(
  entry: ConversationStoreEntry,
  batch: ResettableConversationRowOpBatch,
  sawUserTurnUpsert: boolean
): Pick<
  ConversationStoreEntry,
  | 'controlsAgentId'
  | 'sessionModes'
  | 'sessionConfigOptions'
  | 'availableCommands'
  | 'sessionGoal'
  | 'asyncTasks'
  | 'promptSuggestion'
> {
  return {
    controlsAgentId:
      batch.session_modes != null || batch.session_config_options != null
        ? (normalizeAgentIdentity(
            entry.detail?.summary.agent_id ??
              entry.detail?.active_binding?.agent_type ??
              null
          ) ?? entry.controlsAgentId)
        : entry.controlsAgentId,
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

function applyRowOpBatch(
  entry: ConversationStoreEntry,
  batch: ResettableConversationRowOpBatch
): ConversationStoreEntry {
  const isReset = Boolean(batch.reset);
  const detectedGap: ConversationGapState = isReset
    ? { kind: 'none' }
    : detectSequenceGap(entry.lastSequence, batch);
  const hasExplicitForwardGap =
    !isReset &&
    batch.previous_sequence != null &&
    toBigInt(batch.previous_sequence) > entry.lastSequence;
  if (hasExplicitForwardGap && detectedGap.kind === 'gap') {
    const mergedGap: ConversationGapState =
      entry.gap.kind === 'gap'
        ? {
            kind: 'gap',
            expectedSequence: entry.gap.expectedSequence,
            receivedSequence:
              detectedGap.receivedSequence > entry.gap.receivedSequence
                ? detectedGap.receivedSequence
                : entry.gap.receivedSequence,
          }
        : detectedGap;
    return {
      ...entry,
      gap: mergedGap,
      ...applyBatchMetadata(entry, batch, false),
    };
  }
  const applied = applyOpsSequence(
    {
      conversationId: entry.conversationId,
      windowRows: isReset ? [] : entry.windowRows,
      liveRows: isReset ? [] : entry.liveRows,
      liveText: isReset ? {} : entry.liveText,
      settledAssistantRowIds: isReset ? {} : entry.settledAssistantRowIds,
      currentTurnId: isReset ? null : entry.currentTurnId,
      optimisticTurns: entry.optimisticTurns,
      optimisticBaselineUserRowIds: entry.optimisticBaselineUserRowIds,
      fallbackTurnStartedAt: extractCurrentTurnStartedAt(entry.detail),
    },
    batch.ops,
    isReset ? 0n : entry.loadedLastSequence
  );
  let { windowRows, liveRows } = applied;
  const {
    liveText,
    settledAssistantRowIds,
    currentTurnId,
    optimisticTurns,
    sawUserTurnUpsert,
  } = applied;
  const optimisticBaselineUserRowIds = pruneOptimisticBaselines(
    entry.optimisticBaselineUserRowIds,
    optimisticTurns
  );

  let rows: TimelineRow[];
  if (
    !isReset &&
    windowRows === entry.windowRows &&
    liveRows === entry.liveRows
  ) {
    rows = entry.rows;
  } else {
    liveRows = dropSeededInitialPrompt(
      entry.conversationId,
      liveRows,
      optimisticTurns
    );
    windowRows = dropSeededInitialPrompt(
      entry.conversationId,
      windowRows,
      optimisticTurns
    );
    rows = combineWindowAndLiveRows(
      entry.conversationId,
      windowRows,
      liveRows,
      liveText
    );
  }

  const lastSequence = toBigInt(batch.last_sequence);
  return {
    ...entry,
    windowRows,
    liveRows,
    rows,
    liveText,
    settledAssistantRowIds,
    currentTurnId,
    optimisticTurns,
    optimisticBaselineUserRowIds,
    lastSequence: isReset
      ? lastSequence
      : lastSequence > entry.lastSequence
        ? lastSequence
        : entry.lastSequence,
    loadedLastSequence: isReset ? 0n : entry.loadedLastSequence,
    olderCursor: isReset ? null : entry.olderCursor,
    prefixHash: isReset ? null : entry.prefixHash,
    userTurnsBeforeOffset: isReset ? 0 : entry.userTurnsBeforeOffset,
    loadedToStart: isReset ? true : entry.loadedToStart,
    gap: detectedGap,
    ...applyBatchMetadata(entry, batch, sawUserTurnUpsert),
  };
}

/** Insert or replace a row by `row_id` (idempotent by `revision`), clearing its live text. */
function upsertRow(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  incoming: TimelineRow,
  rowIndexById?: Map<string, number>,
  windowRows?: TimelineRow[]
): {
  rows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
  applied: boolean;
} {
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
      return { rows, liveText, applied: false };
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
  let nextLive = liveText;
  const overlay = liveText[incoming.row_id];
  if (
    applied &&
    overlay &&
    (incomingRevision >= overlayRevisionHorizon(overlay) || terminalConverged)
  ) {
    nextLive = { ...liveText };
    delete nextLive[incoming.row_id];
  }
  return { rows: nextRows, liveText: nextLive, applied };
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
  if (existing === incoming) {
    if (!overlay) return incoming;
    if (
      isOverlayAheadOfRevision(overlay, incomingRevision) ||
      incoming.row.turn.blocks.length === 0
    ) {
      const mergedBlocks =
        incoming.row.turn.blocks.length > 0
          ? mergeAssistantBlocks(
              incoming.row.turn.blocks,
              overlayLiveText([], overlay)
            )
          : overlayLiveText([], overlay);
      return {
        ...incoming,
        row: {
          ...incoming.row,
          turn: {
            ...incoming.row.turn,
            blocks: mergedBlocks,
          },
        },
      };
    }
    return incoming;
  }
  const existingRevision = toBigInt(existing.revision);
  const shouldApplyOverlay = Boolean(
    overlay &&
      (incomingRevision >= overlayRevisionHorizon(overlay) ||
        forceApplyOverlay) &&
      isOverlayAheadOfRevision(overlay, existingRevision)
  );
  const baseBlocks =
    shouldApplyOverlay && overlay
      ? overlayLiveText(existing.row.turn.blocks, overlay)
      : existing.row.turn.blocks;
  if (baseBlocks.length === 0) {
    return incoming;
  }
  const incomingAuthoritative =
    incomingRevision >= existingRevision &&
    (!overlay || incomingRevision >= overlayRevisionHorizon(overlay));
  const mergedBlocks =
    incoming.row.turn.blocks.length > 0
      ? mergeAssistantBlocks(baseBlocks, incoming.row.turn.blocks, {
          preferClientText: incomingAuthoritative,
        })
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

function advanceOverlayOnPatch(
  liveText: Record<string, LiveTextOverlay>,
  rowId: string,
  overlay: LiveTextOverlay | undefined,
  revision: bigint,
  consumeOverlay: boolean
): Record<string, LiveTextOverlay> {
  if (consumeOverlay) {
    const nextLive = { ...liveText };
    delete nextLive[rowId];
    return nextLive;
  }
  if (overlay && overlay.revision <= revision) {
    const nextPatchedRevision =
      overlay.patchedRevision !== undefined &&
      overlay.patchedRevision > revision
        ? overlay.patchedRevision
        : revision;
    return {
      ...liveText,
      [rowId]: { ...overlay, patchedRevision: nextPatchedRevision },
    };
  }
  return liveText;
}

function patchExistingMessageRow(
  existing: TimelineRow & { row: { kind: 'message_turn'; turn: MessageTurn } },
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  overlay: LiveTextOverlay | undefined,
  revision: bigint,
  liveRows: readonly TimelineRow[],
  windowRows?: readonly TimelineRow[],
  fallbackStartedAt?: string | null
): { patched: TimelineRow; consumeOverlay: boolean } {
  const consumeOverlay = Boolean(
    overlay &&
      overlay.revision <= revision &&
      willAppendNewPatchedBlock(existing.row.turn.blocks, op.blocks)
  );
  const baseBlocks =
    consumeOverlay && overlay
      ? overlayLiveText(existing.row.turn.blocks, overlay)
      : existing.row.turn.blocks;
  return {
    consumeOverlay,
    patched: {
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
                  liveRows,
                  op.row_id,
                  fallbackStartedAt,
                  windowRows
                ),
          blocks: mergePatchedBlocks(baseBlocks, op.blocks),
          usage: mergeReportedTurnUsage(existing.row.turn.usage, op.usage),
        },
      },
    },
  };
}

function applyPatchBlocks(
  rows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>,
  op: Extract<ConversationRowOp, { op: 'patch_blocks' }>,
  rowIndexById: Map<string, number>,
  windowRows?: TimelineRow[],
  conversationId?: string,
  fallbackStartedAt?: string | null
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
      const { patched, consumeOverlay } = patchExistingMessageRow(
        windowExisting as TimelineRow & {
          row: { kind: 'message_turn'; turn: MessageTurn };
        },
        op,
        overlay,
        revision,
        rows,
        windowRows,
        fallbackStartedAt
      );
      const nextRows = insertTimelineRow(rows, patched);
      rebuildRowIndex(nextRows, rowIndexById);
      return {
        rows: nextRows,
        liveText: advanceOverlayOnPatch(
          liveText,
          op.row_id,
          overlay,
          revision,
          consumeOverlay
        ),
      };
    }
    if (revision < maxLiveRowRevision(rows, conversationId)) {
      return { rows, liveText };
    }
    const consumeOverlay = Boolean(
      overlay && overlay.revision <= revision && op.blocks.length > 0
    );
    const baseBlocks =
      consumeOverlay && overlay ? overlayLiveText([], overlay) : [];
    const stub = stubAssistantRow(
      { ...op, blocks: mergePatchedBlocks(baseBlocks, op.blocks) },
      rows,
      fallbackStartedAt,
      windowRows
    );
    const nextRows = insertTimelineRow(rows, stub);
    rebuildRowIndex(nextRows, rowIndexById);
    return {
      rows: nextRows,
      liveText: advanceOverlayOnPatch(
        liveText,
        op.row_id,
        overlay,
        revision,
        consumeOverlay
      ),
    };
  }
  const existing = rows[index];
  if (
    !existing ||
    revision < toBigInt(existing.revision) ||
    existing.row.kind !== 'message_turn'
  ) {
    return { rows, liveText };
  }
  const { patched, consumeOverlay } = patchExistingMessageRow(
    existing as TimelineRow & {
      row: { kind: 'message_turn'; turn: MessageTurn };
    },
    op,
    overlay,
    revision,
    rows,
    windowRows,
    fallbackStartedAt
  );
  const nextRows = rows.slice();
  nextRows[index] = patched;
  return {
    rows: nextRows,
    liveText: advanceOverlayOnPatch(
      liveText,
      op.row_id,
      overlay,
      revision,
      consumeOverlay
    ),
  };
}

function createEntry(conversationId: string): ConversationStoreEntry {
  return {
    conversationId,
    detail: null,
    windowRows: [],
    liveRows: [],
    rows: [],
    liveText: {},
    settledAssistantRowIds: {},
    lastSequence: 0n,
    loadedLastSequence: 0n,
    projectionVersion: null,
    currentTurnId: null,
    loading: false,
    error: null,
    gap: { kind: 'none' },
    optimisticTurns: [],
    optimisticBaselineUserRowIds: {},
    controlsAgentId: null,
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
