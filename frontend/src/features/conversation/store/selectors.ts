import type { MessageTurn, TimelineRow } from 'shared/types';
import { plausibleTurnStartMs } from '@/components/conversation-thread/turnClock';
import {
  alignStreamingAssistantWithUserPhase,
  dedupeTurns,
  isLiveProjectorRowId,
  liveOverlayForRow,
  mergeOptimisticUsersBeforeOrphanAssistants,
  messageTurnPairKey,
  orderSameTurnUserBeforeAssistant,
  overlayLiveText,
  toBigInt,
  withPendingAssistantTurns,
} from './queue';
import { defaultInlineSideRow, sideRowsForEntry } from './permissions';
import {
  selectActiveTurnStartedAt,
  type ConversationStoreEntry,
  type ConversationStoreState,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
  type LiveTextOverlay,
} from './turnLifecycle';

type CachedProjectedRowTurn = {
  blocks: MessageTurn['blocks'];
  phase: string;
  revision: TimelineRow['revision'];
  overlay: LiveTextOverlay | undefined;
  timestampOverride: string | null;
  forkPointStatus: ConversationTimelineTurn['forkPointStatus'];
  result: ConversationTimelineTurn;
};

const projectedRowTurnCache = new WeakMap<
  TimelineRow,
  CachedProjectedRowTurn
>();

export function timelineTurnsForEntry(
  entry: ConversationStoreEntry | null
): ConversationTimelineTurn[] {
  if (!entry) return [];
  const activeTurnId =
    entry.detail?.current_turn?.id ??
    entry.detail?.in_flight_user_turn_id ??
    entry.currentTurnId;
  const activeStartedAt = selectActiveTurnStartedAt(entry);
  const activeStartedMs = activeStartedAt
    ? plausibleTurnStartMs(activeStartedAt)
    : null;
  const hasActiveUserRow = activeTurnId
    ? entry.rows.some(
        (row) =>
          row.row.kind === 'message_turn' &&
          row.row.turn.role === 'user' &&
          (row.row_id === `${activeTurnId}:user` ||
            row.row.turn.id === `${activeTurnId}:user`)
      )
    : false;
  const persisted = entry.rows.flatMap((row) => {
    if (row.row.kind !== 'message_turn') return [];
    const overlay = liveOverlayForRow(row, entry.liveText);
    let timestampOverride: string | null = null;
    if (
      row.row.phase === 'streaming' &&
      row.row.turn.role === 'assistant' &&
      activeTurnId &&
      !hasActiveUserRow &&
      activeStartedAt &&
      activeStartedMs !== null &&
      messageTurnPairKey(row.row_id) === activeTurnId
    ) {
      const existingMs = plausibleTurnStartMs(row.row.turn.timestamp);
      if (existingMs === null || activeStartedMs < existingMs) {
        timestampOverride = activeStartedAt;
      }
    }
    const forkPointStatus: ConversationTimelineTurn['forkPointStatus'] =
      'fork_point_status' in row.row
        ? ((
            row.row as {
              fork_point_status?: ConversationTimelineTurn['forkPointStatus'];
            }
          ).fork_point_status ?? null)
        : null;
    const cached = projectedRowTurnCache.get(row);
    if (
      cached &&
      cached.blocks === row.row.turn.blocks &&
      cached.phase === row.row.phase &&
      cached.revision === row.revision &&
      cached.overlay === overlay &&
      cached.timestampOverride === timestampOverride &&
      cached.forkPointStatus === forkPointStatus
    ) {
      return [cached.result];
    }
    let turn = overlay
      ? {
          ...row.row.turn,
          blocks: overlayLiveText(row.row.turn.blocks, overlay),
        }
      : row.row.turn;
    if (timestampOverride !== null) {
      turn = { ...turn, timestamp: timestampOverride };
    }
    const projected: ConversationTimelineTurn = {
      key: `conversation-${row.row_id}`,
      turn,
      revision: toBigInt(row.revision),
      phase: row.row.phase as ConversationTimelineTurn['phase'],
      forkPointStatus,
    };
    projectedRowTurnCache.set(row, {
      blocks: row.row.turn.blocks,
      phase: row.row.phase,
      revision: row.revision,
      overlay,
      timestampOverride,
      forkPointStatus,
      result: projected,
    });
    return [projected];
  });
  const maxRowRevision = entry.rows.reduce((max, row) => {
    if (!isLiveProjectorRowId(row.row_id, entry.conversationId)) return max;
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
      ),
      {
        activeTurnId: activeTurnId ?? null,
        activeStartedAt,
      }
    )
  );
}

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
      !isLiveProjectorRowId(message.item.turn.id, entry?.conversationId) &&
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
