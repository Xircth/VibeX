import type {
  ContentBlock,
  ConversationTimeline,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

import {
  getSessionComposerStructuredTokens,
  serializeSessionComposerBackendMessage,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { plausibleTurnStartMs } from '@/components/conversation-thread/turnClock';
import { mergeReportedTurnUsage } from '../reportedTurnUsage';
import type {
  ConversationStoreEntry,
  ConversationTimelineTurn,
  LiveTextOverlay,
} from './turnLifecycle';

export function mergePatchedBlocks(
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

export function hasPotentialStructuredToken(text: string): boolean {
  return text.includes('[');
}

/**
 * User turns are immutable after submission, but agent runtimes echo slash/skill
 * commands as normalized plain text. Once the optimistic turn has supplied the
 * richer serialized token, keep that presentation payload across every later
 * projector revision of the same row. Non-text blocks and row metadata remain
 * authoritative.
 */
export function preserveStructuredUserText(
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

export const TERMINAL_ROW_PHASES = new Set([
  'persisted',
  'settled',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isLateSettledAssistantAppend(
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

export function isLiveTurnConvergedInWindow(
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
    if (
      expectedBlocks.length === 0 &&
      liveAssistants.some(
        (row) =>
          row.row.kind === 'message_turn' &&
          !TERMINAL_ROW_PHASES.has(row.row.phase)
      )
    ) {
      return false;
    }
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

export function windowBlocksCoverLiveBlocks(
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
  const windowThinking = windowBlocks
    .flatMap((block) => (block.type === 'thinking' ? [block.text] : []))
    .join('')
    .trim();
  const liveThinking = liveBlocks
    .flatMap((block) => (block.type === 'thinking' ? [block.text] : []))
    .join('')
    .trim();
  if (liveThinking.length > 0 && !windowThinking.includes(liveThinking)) {
    return false;
  }
  if (
    liveBlocks.some((block) => block.type === 'plan') &&
    !windowBlocks.some((block) => block.type === 'plan')
  ) {
    return false;
  }
  const windowToolIds = new Set(toolUseIdsOf(windowBlocks));
  for (const toolId of toolUseIdsOf(liveBlocks)) {
    if (!windowToolIds.has(toolId)) return false;
  }
  return true;
}

const STANDALONE_RESOURCE_LINK_PATTERN = /\[[^\]]*\]\(<file:\/\/[^>\n]+>\)/g;

export function normalizePromptMatchText(text: string): string {
  const withoutResourceLinks = text
    .replace(STANDALONE_RESOURCE_LINK_PATTERN, '')
    .trim();
  if (!hasPotentialStructuredToken(withoutResourceLinks)) {
    return withoutResourceLinks;
  }
  return serializeSessionComposerBackendMessage(withoutResourceLinks).trim();
}

export function promptsMatch(left: string, right: string): boolean {
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
    normalizePromptMatchText(leftTrimmed) ===
    normalizePromptMatchText(rightTrimmed)
  );
}

type MessageRound = {
  userRow: TimelineRow | null;
  assistantRows: TimelineRow[];
  rows: TimelineRow[];
  isStreamingOrOpen: boolean;
};

function isRoundStartUser(row: TimelineRow): boolean {
  return (
    row.row.kind === 'message_turn' &&
    row.row.turn.role === 'user' &&
    !row.row_id.includes(':steer:')
  );
}

function isStreamingOrOpenRound(
  userRow: TimelineRow | null,
  assistantRows: TimelineRow[]
): boolean {
  return (
    (userRow?.row.kind === 'message_turn' &&
      userRow.row.phase === 'streaming') ||
    assistantRows.length === 0 ||
    assistantRows.some(
      (row) => row.row.kind === 'message_turn' && row.row.phase === 'streaming'
    )
  );
}

function partitionMessageRounds(rows: TimelineRow[]): {
  prefix: TimelineRow[];
  rounds: MessageRound[];
} {
  const firstMessageIndex = rows.findIndex(
    (row) => row.row.kind === 'message_turn'
  );
  if (firstMessageIndex < 0) {
    return { prefix: rows, rounds: [] };
  }

  const prefix = rows.slice(0, firstMessageIndex);
  const rounds: MessageRound[] = [];
  let start = firstMessageIndex;
  const first = rows[start]!;
  let userRow: TimelineRow | null = isRoundStartUser(first) ? first : null;
  let assistantRows: TimelineRow[] =
    first.row.kind === 'message_turn' && first.row.turn.role === 'assistant'
      ? [first]
      : [];

  const flush = (end: number) => {
    const slice = rows.slice(start, end);
    if (slice.length === 0) return;
    rounds.push({
      userRow,
      assistantRows,
      rows: slice,
      isStreamingOrOpen: isStreamingOrOpenRound(userRow, assistantRows),
    });
  };

  for (let index = firstMessageIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (isRoundStartUser(row)) {
      flush(index);
      start = index;
      userRow = row;
      assistantRows = [];
      continue;
    }
    if (row.row.kind === 'message_turn' && row.row.turn.role === 'assistant') {
      assistantRows.push(row);
    }
  }
  flush(rows.length);
  return { prefix, rounds: splitTrailingOrphanAssistant(rounds) };
}

function splitTrailingOrphanAssistant(rounds: MessageRound[]): MessageRound[] {
  if (rounds.length === 0) return rounds;
  const last = rounds[rounds.length - 1]!;
  const messages = last.rows.filter((row) => row.row.kind === 'message_turn');
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (
    !lastMessage ||
    lastMessage.row.kind !== 'message_turn' ||
    lastMessage.row.turn.role !== 'assistant' ||
    lastMessage.row.phase !== 'streaming'
  ) {
    return rounds;
  }
  if (
    previousMessage &&
    previousMessage.row.kind === 'message_turn' &&
    previousMessage.row.turn.role === 'user'
  ) {
    return rounds;
  }
  const orphanIndex = last.rows.lastIndexOf(lastMessage);
  if (orphanIndex <= 0) return rounds;
  const keptRows = last.rows.slice(0, orphanIndex);
  const orphanRows = last.rows.slice(orphanIndex);
  const keptAssistants = last.assistantRows.filter(
    (row) => row.row_id !== lastMessage.row_id
  );
  const kept: MessageRound = {
    userRow: last.userRow,
    assistantRows: keptAssistants,
    rows: keptRows,
    isStreamingOrOpen: isStreamingOrOpenRound(last.userRow, keptAssistants),
  };
  const orphan: MessageRound = {
    userRow: null,
    assistantRows: [lastMessage],
    rows: orphanRows,
    isStreamingOrOpen: true,
  };
  return [...rounds.slice(0, -1), kept, orphan];
}

function roundAssistantBlocks(round: MessageRound): ContentBlock[] {
  return round.assistantRows.flatMap((row) =>
    row.row.kind === 'message_turn' ? row.row.turn.blocks : []
  );
}

function liveBlocksExtendWindowBlocks(
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
  const windowThinking = windowBlocks
    .flatMap((block) => (block.type === 'thinking' ? [block.text] : []))
    .join('')
    .trim();
  const liveThinking = liveBlocks
    .flatMap((block) => (block.type === 'thinking' ? [block.text] : []))
    .join('')
    .trim();
  if (liveText.length === 0 && liveThinking.length === 0) return false;
  const textExtends =
    windowText.length === 0
      ? liveText.length > 0 || windowThinking.length > 0
      : liveText.startsWith(windowText);
  const thinkingExtends =
    windowThinking.length === 0 || liveThinking.startsWith(windowThinking);
  return textExtends && thinkingExtends;
}

function roundsAlign(
  windowRound: MessageRound,
  liveRound: MessageRound
): boolean {
  const firstLiveUser = liveRound.userRow;
  const firstLiveAssistant = liveRound.assistantRows[0] ?? null;

  if (
    windowRound.userRow === null &&
    windowRound.isStreamingOrOpen &&
    Boolean(firstLiveUser || firstLiveAssistant)
  ) {
    return true;
  }
  if (
    windowRound.userRow !== null &&
    windowRound.isStreamingOrOpen &&
    !firstLiveUser &&
    Boolean(firstLiveAssistant)
  ) {
    return true;
  }
  if (
    !windowRound.userRow ||
    !firstLiveUser ||
    windowRound.userRow.row.kind !== 'message_turn' ||
    firstLiveUser.row.kind !== 'message_turn'
  ) {
    return false;
  }
  if (
    !promptsMatch(
      userTurnText(windowRound.userRow.row.turn),
      userTurnText(firstLiveUser.row.turn)
    )
  ) {
    return false;
  }
  if (livePromptStartsAfterWindowUser(firstLiveUser, windowRound.userRow)) {
    return false;
  }

  if (windowRound.isStreamingOrOpen) return true;

  const liveHasTerminalPhase = liveRound.rows.some(
    (row) =>
      row.row.kind === 'message_turn' && TERMINAL_ROW_PHASES.has(row.row.phase)
  );
  const windowAssistantBlocks = roundAssistantBlocks(windowRound);
  const liveAssistantBlocks = roundAssistantBlocks(liveRound);
  if (
    liveHasTerminalPhase &&
    windowBlocksCoverLiveBlocks(windowAssistantBlocks, liveAssistantBlocks)
  ) {
    return true;
  }

  const liveStillStreaming = liveRound.rows.some(
    (row) => row.row.kind === 'message_turn' && row.row.phase === 'streaming'
  );
  return (
    liveStillStreaming &&
    liveBlocksExtendWindowBlocks(windowAssistantBlocks, liveAssistantBlocks)
  );
}

function seedWindowAssistantIntoLive(
  liveRows: TimelineRow[],
  liveUser: TimelineRow,
  windowAssistant: TimelineRow,
  liveText: Record<string, LiveTextOverlay>
): TimelineRow[] {
  if (windowAssistant.row.kind !== 'message_turn') return liveRows;
  const hasLiveAssistant = liveRows.some(
    (row) =>
      row.row.kind === 'message_turn' && row.row.turn.role === 'assistant'
  );
  if (hasLiveAssistant) return liveRows;
  const turnKey = messageTurnPairKey(liveUser.row_id);
  const assistantId = turnKey ? `${turnKey}:assistant` : null;
  if (!assistantId) return liveRows;
  const overlay = liveText[assistantId];
  const blocks = overlay
    ? overlayLiveText(windowAssistant.row.turn.blocks, overlay)
    : windowAssistant.row.turn.blocks;
  return insertTimelineRow(liveRows, {
    row_id: assistantId,
    revision: overlay ? overlay.revision : windowAssistant.revision,
    row: {
      kind: 'message_turn',
      phase:
        liveUser.row.kind === 'message_turn' &&
        TERMINAL_ROW_PHASES.has(liveUser.row.phase)
          ? liveUser.row.phase
          : 'streaming',
      turn: {
        ...windowAssistant.row.turn,
        id: assistantId,
        blocks,
      },
    },
  });
}

function spliceLiveRoundIntoWindow(
  windowRound: MessageRound,
  liveRound: MessageRound,
  liveText: Record<string, LiveTextOverlay>
): TimelineRow[] {
  let liveRows = liveRound.rows.slice();
  const firstLiveAssistant = liveRound.assistantRows[0];
  const windowAssistantBlocks = roundAssistantBlocks(windowRound);

  if (windowAssistantBlocks.length > 0 && firstLiveAssistant) {
    liveRows = liveRows.map((row) => {
      if (
        row.row_id !== firstLiveAssistant.row_id ||
        row.row.kind !== 'message_turn'
      ) {
        return row;
      }
      const windowAssistantTurn =
        windowRound.assistantRows[0]?.row.kind === 'message_turn'
          ? {
              ...windowRound.assistantRows[0]!.row.turn,
              blocks: windowAssistantBlocks,
            }
          : row.row.turn;
      return {
        ...row,
        row: {
          ...row.row,
          turn: mergeAssistantTurnData(windowAssistantTurn, row.row.turn),
        },
      };
    });
  }

  const alignsOrphanLiveAssistant =
    windowRound.userRow !== null &&
    windowRound.isStreamingOrOpen &&
    !liveRound.userRow &&
    Boolean(firstLiveAssistant);

  if (alignsOrphanLiveAssistant && windowRound.userRow) {
    const suppressedIds = new Set(
      windowRound.assistantRows.map((row) => row.row_id)
    );
    const kept = windowRound.rows.filter(
      (row) => !suppressedIds.has(row.row_id)
    );
    return [...kept, ...liveRows];
  }

  if (
    liveRound.userRow &&
    liveRound.assistantRows.length === 0 &&
    windowRound.assistantRows.length > 0
  ) {
    liveRows = seedWindowAssistantIntoLive(
      liveRows,
      liveRound.userRow,
      windowRound.assistantRows[0]!,
      liveText
    );
  }

  const windowSideRows = windowRound.rows.filter(
    (row) => row.row.kind !== 'message_turn'
  );
  return [...liveRows, ...windowSideRows];
}

function liveRoundTurnKey(round: MessageRound): string | null {
  return messageTurnPairKey(
    (round.userRow ?? round.assistantRows[0])?.row_id ?? ''
  );
}

/**
 * Render `windowRows` first, then splice each live message round into the
 * matching window round so `acp-N` and `{turn}:*` for the same turn never
 * appear together. Unmatched live rounds append after the window.
 */
export function combineWindowAndLiveRows(
  conversationId: string,
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): TimelineRow[] {
  if (liveRows.length === 0) {
    return windowRows;
  }

  // Replace any exact `row_id` matches in `windowRows` (e.g. unit tests that
  // seeded `{turn}:*` rows via `load_success` and then updated them via `row_ops`).
  const baseRowId = (id: string) => id.split('|')[0] ?? id;
  const liveByRowId = new Map(
    liveRows.map((row) => [baseRowId(row.row_id), row])
  );
  const replacedIds = new Set<string>();
  const effectiveWindow = windowRows.map((row) => {
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
  const remainingLive = liveRows.filter(
    (row) => !replacedIds.has(baseRowId(row.row_id))
  );
  if (remainingLive.length === 0) {
    return dropSeededInitialPrompt(conversationId, effectiveWindow);
  }

  const windowParts = partitionMessageRounds(effectiveWindow);
  const liveParts = partitionMessageRounds(remainingLive);
  const consumedLive = new Set<number>();
  for (const [index, liveRound] of liveParts.rounds.entries()) {
    const turnKey = liveRoundTurnKey(liveRound);
    if (
      turnKey &&
      isLiveTurnConvergedInWindow(
        turnKey,
        effectiveWindow,
        remainingLive,
        liveText
      )
    ) {
      consumedLive.add(index);
    }
  }

  const combined: TimelineRow[] = [...windowParts.prefix];
  for (const windowRound of windowParts.rounds) {
    const liveIndex = liveParts.rounds.findIndex(
      (liveRound, index) =>
        !consumedLive.has(index) && roundsAlign(windowRound, liveRound)
    );
    if (liveIndex < 0) {
      combined.push(...windowRound.rows);
      continue;
    }
    consumedLive.add(liveIndex);
    combined.push(
      ...spliceLiveRoundIntoWindow(
        windowRound,
        liveParts.rounds[liveIndex]!,
        liveText
      )
    );
  }
  combined.push(...liveParts.prefix);
  for (const [index, liveRound] of liveParts.rounds.entries()) {
    if (!consumedLive.has(index)) {
      combined.push(...liveRound.rows);
    }
  }

  return dropSeededInitialPrompt(conversationId, combined);
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

function isStructuredBlock(block: ContentBlock): boolean {
  return (
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'plan'
  );
}

function findMatchingStructuredBlockIndex(
  blocks: ContentBlock[],
  candidate: ContentBlock
): number {
  if (candidate.type === 'tool_use' && candidate.tool_use_id) {
    return blocks.findIndex(
      (b) => b.type === 'tool_use' && b.tool_use_id === candidate.tool_use_id
    );
  }
  if (candidate.type === 'tool_result' && candidate.tool_use_id) {
    return blocks.findIndex(
      (b) =>
        (b.type === 'tool_result' || b.type === 'tool_use') &&
        b.tool_use_id === candidate.tool_use_id
    );
  }
  if (candidate.type === 'plan') {
    return blocks.findIndex((b) => b.type === 'plan');
  }
  return -1;
}

export function mergeAssistantBlocks(
  fileBlocks: ContentBlock[],
  clientBlocks: ContentBlock[]
): ContentBlock[] {
  if (fileBlocks.length === 0) return clientBlocks;
  if (clientBlocks.length === 0) return fileBlocks;

  const fileHasStructured = fileBlocks.some(isStructuredBlock);
  const clientHasStructured = clientBlocks.some(isStructuredBlock);

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

  for (let clientIdx = 0; clientIdx < clientBlocks.length; clientIdx += 1) {
    const candidate = clientBlocks[clientIdx]!;
    if (!isStructuredBlock(candidate)) continue;
    const matchIndex = findMatchingStructuredBlockIndex(fileBlocks, candidate);
    if (matchIndex >= 0) {
      const prefix = mergeAssistantBlocks(
        fileBlocks.slice(0, matchIndex),
        clientBlocks.slice(0, clientIdx)
      );
      const seeded = [
        ...prefix,
        ...fileBlocks.slice(matchIndex).filter(isStructuredBlock),
      ];
      return mergeBlockSequence(seeded, clientBlocks.slice(clientIdx));
    }
  }

  if (windowBlocksCoverLiveBlocks(fileBlocks, clientBlocks)) {
    return mergePatchedBlocks(
      fileBlocks,
      clientBlocks.filter(isStructuredBlock)
    );
  }

  if (windowBlocksCoverLiveBlocks(clientBlocks, fileBlocks)) {
    return clientBlocks;
  }

  const firstClientBlock = clientBlocks[0];
  if (firstClientBlock && isStructuredBlock(firstClientBlock)) {
    return mergeBlockSequence(fileBlocks.slice(), clientBlocks);
  }

  return mergeBlockSequence(fileBlocks, clientBlocks);
}

function mergeBlockSequence(
  baseBlocks: ContentBlock[],
  incomingBlocks: ContentBlock[]
): ContentBlock[] {
  const result = baseBlocks.slice();
  for (const block of incomingBlocks) {
    if (isStructuredBlock(block)) {
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

export function liveOverlayForRow(
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

export function alignStreamingAssistantWithUserPhase(
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

export function overlayLiveText(
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

export function reconcileOptimisticTurns(
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

export function reconcileOptimisticTurnsAgainstRows(
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

export function reconcileOptimisticTurnAgainstUserRow(
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
      normalizePromptMatchText(authoritativeText);
    optimisticIndex = optimisticTurns.findIndex(
      (turn) =>
        normalizePromptMatchText(userTurnText(turn)) ===
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

export function settleIdleOpenTail(
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

export function isLiveProjectorRowId(rowId: string): boolean {
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
export function dropSeededInitialPrompt(
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
      promptsMatch(userTurnText(row.row.turn), seedText)
  );
  if (!duplicated) return rows;
  return rows.filter((row) => row.row_id !== seedId);
}

export function userTurnText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

export function dedupeTurns(
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
export function withPendingAssistantTurns(
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
    let hasFollowingAssistant = false;
    if (pendingUserIndex >= 0) {
      for (
        let index = pendingUserIndex + 1;
        index < result.length;
        index += 1
      ) {
        const row = result[index];
        if (row?.turn.role === 'user' && !row.turn.id.includes(':steer:')) {
          break;
        }
        if (row?.turn.role === 'assistant') {
          hasFollowingAssistant = true;
          break;
        }
      }
    }
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

export function messageTurnPairKey(id: string): string | null {
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
export function orderSameTurnUserBeforeAssistant(
  turns: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  const seenKeys = new Set<string>();
  const hasPrimaryUser = new Set<string>();
  const promotedUserByKey = new Map<string, ConversationTimelineTurn>();

  for (const turn of turns) {
    const key = messageTurnPairKey(turn.turn.id);
    if (!key) continue;
    if (isPrimaryUserTurn(turn) && !hasPrimaryUser.has(key)) {
      hasPrimaryUser.add(key);
      if (seenKeys.has(key)) {
        promotedUserByKey.set(key, turn);
      }
    }
    seenKeys.add(key);
  }

  if (promotedUserByKey.size === 0) return turns;

  const result: ConversationTimelineTurn[] = [];
  const insertedKeys = new Set<string>();
  for (const turn of turns) {
    const key = messageTurnPairKey(turn.turn.id);
    if (key) {
      const promoted = promotedUserByKey.get(key);
      if (promoted) {
        if (turn === promoted) continue;
        if (!insertedKeys.has(key)) {
          insertedKeys.add(key);
          result.push(promoted);
        }
      }
    }
    result.push(turn);
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
export function mergeOptimisticUsersBeforeOrphanAssistants(
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

export function insertTimelineRow(
  rows: TimelineRow[],
  incoming: TimelineRow
): TimelineRow[] {
  if (incoming.row.kind !== 'message_turn') {
    return [...rows, incoming];
  }
  const key = messageTurnPairKey(incoming.row_id);
  if (!key) return [...rows, incoming];

  let insertAt = rows.length;
  let foundSibling = false;
  if (isPrimaryUserRow(incoming)) {
    const sibling = rows.findIndex(
      (row) => messageTurnPairKey(row.row_id) === key
    );
    if (sibling >= 0) {
      insertAt = sibling;
      foundSibling = true;
    }
  } else {
    for (let index = 0; index < rows.length; index += 1) {
      if (messageTurnPairKey(rows[index]?.row_id ?? '') === key) {
        insertAt = index + 1;
        foundSibling = true;
      }
    }
  }
  if (!foundSibling) {
    const incomingStartMs = plausibleTurnStartMs(incoming.row.turn.timestamp);
    if (incomingStartMs !== null) {
      const newerIndex = rows.findIndex((candidate) => {
        if (candidate.row.kind !== 'message_turn') return false;
        const candidateKey = messageTurnPairKey(candidate.row_id);
        if (!candidateKey || candidateKey === key) return false;
        const candidateStartMs = plausibleTurnStartMs(
          candidate.row.turn.timestamp
        );
        return candidateStartMs !== null && candidateStartMs > incomingStartMs;
      });
      if (newerIndex >= 0) {
        insertAt = newerIndex;
      }
    }
  }
  return [...rows.slice(0, insertAt), incoming, ...rows.slice(insertAt)];
}

export function rebuildRowIndex(
  rows: TimelineRow[],
  rowIndexById?: Map<string, number>
) {
  if (!rowIndexById) return;
  rowIndexById.clear();
  rows.forEach((row, index) => rowIndexById.set(row.row_id, index));
}

export function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
