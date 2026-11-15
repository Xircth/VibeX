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
  const indexById = new Map<string, number>();
  let planIndex = -1;
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    if (!b) continue;
    if (b.type === 'tool_use' && b.tool_use_id) {
      indexById.set(`tool_use:${b.tool_use_id}`, i);
    } else if (b.type === 'tool_result' && b.tool_use_id) {
      indexById.set(`tool_result:${b.tool_use_id}`, i);
    } else if (b.type === 'plan') {
      planIndex = i;
    }
  }
  for (const block of incoming) {
    if (block.type === 'tool_use' && block.tool_use_id) {
      const key = `tool_use:${block.tool_use_id}`;
      const match = indexById.get(key);
      if (match !== undefined) {
        next[match] = block;
      } else {
        indexById.set(key, next.length);
        next.push(block);
      }
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      const key = `tool_result:${block.tool_use_id}`;
      const match = indexById.get(key);
      if (match !== undefined) {
        next[match] = block;
      } else {
        indexById.set(key, next.length);
        next.push(block);
      }
    } else if (block.type === 'plan') {
      if (planIndex >= 0) {
        next[planIndex] = block;
      } else {
        planIndex = next.length;
        next.push(block);
      }
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

const ABORTED_USER_ROW_PHASES = new Set(['failed', 'cancelled', 'interrupted']);

/**
 * Single-authority row combination: `windowRows` and `liveRows` share canonical
 * SQLite `row_id`s (`{turn_id}:user`, `{turn_id}:assistant`, `{turn_id}:steer:*`,
 * and side rows). Matching `row_id`s update in-place monotonically by `revision`;
 * newer unmatched live rows insert beside same-turn siblings or append at the tail.
 */
export function combineWindowAndLiveRows(
  conversationId: string,
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  _liveText?: Record<string, LiveTextOverlay>
): TimelineRow[] {
  if (liveRows.length === 0) {
    return windowRows;
  }

  const baseRowId = (id: string) => id.split('|')[0] ?? id;
  const liveByRowId = new Map(
    liveRows.map((row) => [baseRowId(row.row_id), row])
  );
  const replacedIds = new Set<string>();
  let combined = windowRows.map((row) => {
    const baseId = baseRowId(row.row_id);
    const replacement = liveByRowId.get(baseId);
    if (!replacement) return row;
    replacedIds.add(baseId);
    const isTerminalUpgrade =
      replacement.row.kind === 'message_turn' &&
      TERMINAL_ROW_PHASES.has(replacement.row.phase) &&
      row.row.kind === 'message_turn' &&
      !TERMINAL_ROW_PHASES.has(row.row.phase);
    if (
      toBigInt(replacement.revision) < toBigInt(row.revision) &&
      !isTerminalUpgrade
    ) {
      return row;
    }
    const merged = preserveStructuredUserText(row, replacement);
    if (row.row_id.includes('|') && !merged.row_id.includes('|')) {
      return { ...merged, row_id: row.row_id };
    }
    return merged;
  });

  for (const liveRow of liveRows) {
    if (replacedIds.has(baseRowId(liveRow.row_id))) continue;
    combined = insertTimelineRow(combined, liveRow);
  }

  return dropSeededInitialPrompt(conversationId, combined);
}

const CLIENT_ASSISTANT_ID = /:assistant(?::\d+)?$/;

function isClientAssistantId(id: string): boolean {
  return CLIENT_ASSISTANT_ID.test(id);
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

  if (!fileHasStructured && clientHasStructured) {
    const firstStructuredIdx = clientBlocks.findIndex(isStructuredBlock);
    const prefix = mergeAssistantBlocks(
      fileBlocks,
      clientBlocks.slice(0, firstStructuredIdx)
    );
    return mergeBlockSequence(prefix, clientBlocks.slice(firstStructuredIdx));
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
  timeline: ConversationTimeline,
  baselineUserRowIds?: Readonly<Record<string, readonly string[]>>
): MessageTurn[] {
  return reconcileOptimisticTurnsAgainstRows(
    optimisticTurns,
    timeline.rows,
    baselineUserRowIds
  ).optimisticTurns;
}

export function reconcileOptimisticTurnsAgainstRows(
  optimisticTurns: MessageTurn[],
  rows: TimelineRow[],
  baselineUserRowIds?: Readonly<Record<string, readonly string[]>>
): { rows: TimelineRow[]; optimisticTurns: MessageTurn[] } {
  let remainingTurns = optimisticTurns;
  const reconciledRows = [...rows].reverse().map((row) => {
    const reconciled = reconcileOptimisticTurnAgainstUserRow(
      remainingTurns,
      row,
      baselineUserRowIds
    );
    remainingTurns = reconciled.optimisticTurns;
    return reconciled.row;
  });
  return {
    rows: reconciledRows.reverse(),
    optimisticTurns: remainingTurns,
  };
}

function isBaselineUserRowForOptimisticTurn(
  turnId: string,
  rowId: string,
  baselineUserRowIds?: Readonly<Record<string, readonly string[]>>
): boolean {
  const baseline = baselineUserRowIds?.[turnId];
  if (!baseline || baseline.length === 0) return false;
  return baseline.includes(rowId);
}

export function reconcileOptimisticTurnAgainstUserRow(
  optimisticTurns: MessageTurn[],
  row: TimelineRow,
  baselineUserRowIds?: Readonly<Record<string, readonly string[]>>
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
    (turn) =>
      !isBaselineUserRowForOptimisticTurn(
        turn.id,
        row.row_id,
        baselineUserRowIds
      ) && userTurnText(turn) === authoritativeText
  );

  if (optimisticIndex < 0) {
    const authoritativeBackendText =
      normalizePromptMatchText(authoritativeText);
    optimisticIndex = optimisticTurns.findIndex(
      (turn) =>
        !isBaselineUserRowForOptimisticTurn(
          turn.id,
          row.row_id,
          baselineUserRowIds
        ) &&
        normalizePromptMatchText(userTurnText(turn)) ===
          authoritativeBackendText
    );
  }

  if (optimisticIndex < 0) return { row, optimisticTurns };

  const optimisticTurn = optimisticTurns[optimisticIndex]!;
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
  if (assistant) return assistant[1]!;
  const steer = /^(.*):steer:/.exec(id);
  if (steer) return steer[1]!;
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
 * Optimistic user ids are temporary (`optimistic-*`). If the matching streaming
 * assistant row at the tail of the timeline already landed before its `:user`
 * row, keep the optimistic user in front of that tail streaming assistant
 * without ever splicing before earlier historical turns.
 */
export function mergeOptimisticUsersBeforeOrphanAssistants(
  persisted: ConversationTimelineTurn[],
  optimistic: ConversationTimelineTurn[]
): ConversationTimelineTurn[] {
  if (optimistic.length === 0) return persisted;
  const result = [...persisted];
  const filledKeys = new Set<string>();
  for (const turn of optimistic) {
    let tailStartIndex = result.length;
    while (tailStartIndex > 0) {
      const candidate = result[tailStartIndex - 1]!;
      if (
        candidate.turn.role !== 'assistant' ||
        candidate.phase !== 'streaming'
      ) {
        break;
      }
      tailStartIndex -= 1;
    }
    let orphanIndex = -1;
    for (let index = tailStartIndex; index < result.length; index += 1) {
      const candidate = result[index]!;
      if (candidate.turn.role !== 'assistant') continue;
      const key = messageTurnPairKey(candidate.turn.id);
      if (!key || filledKeys.has(key)) continue;
      if (hasPairedUser(result, candidate.turn.id)) continue;
      orphanIndex = index;
      break;
    }
    if (orphanIndex < 0) {
      result.push(turn);
      continue;
    }
    const orphan = result[orphanIndex]!;
    const key = messageTurnPairKey(orphan.turn.id);
    if (key) filledKeys.add(key);
    result.splice(orphanIndex, 0, turn);
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
  if (!foundSibling && ABORTED_USER_ROW_PHASES.has(incoming.row.phase)) {
    const incomingRevision = toBigInt(incoming.revision);
    if (incomingRevision > 0n) {
      let tailStreamingStart = rows.length;
      while (tailStreamingStart > 0) {
        const candidate = rows[tailStreamingStart - 1]!;
        if (
          candidate.row.kind === 'message_turn' &&
          candidate.row.phase !== 'streaming'
        ) {
          break;
        }
        tailStreamingStart -= 1;
      }
      for (let index = tailStreamingStart; index < rows.length; index += 1) {
        const candidate = rows[index]!;
        if (
          candidate.row.kind !== 'message_turn' ||
          candidate.row.phase !== 'streaming'
        ) {
          continue;
        }
        const candidateKey = messageTurnPairKey(candidate.row_id);
        if (!candidateKey || candidateKey === key) continue;
        if (incomingRevision < toBigInt(candidate.revision)) {
          insertAt = index;
          break;
        }
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

export function preserveStructuredUserTextFromLiveRows(
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
    const match =
      liveUsers.find((live) => live.row_id === row.row_id) ??
      liveUsers.find(
        (live) =>
          live.row.kind === 'message_turn' &&
          promptsMatch(userTurnText(live.row.turn), userTurnText(windowTurn))
      );
    return match ? preserveStructuredUserText(match, row) : row;
  });
}

export function pruneConvergedLiveState(
  windowRows: TimelineRow[],
  liveRows: TimelineRow[],
  liveText: Record<string, LiveTextOverlay>
): {
  liveRows: TimelineRow[];
  liveText: Record<string, LiveTextOverlay>;
} {
  if (liveRows.length === 0) {
    return { liveRows, liveText };
  }
  const baseRowId = (id: string) => id.split('|')[0] ?? id;
  const windowByBaseId = new Map<string, TimelineRow>();
  for (const row of windowRows) {
    windowByBaseId.set(baseRowId(row.row_id), row);
  }
  const nextLiveRows = liveRows.filter((row) => {
    const winRow = windowByBaseId.get(baseRowId(row.row_id));
    if (!winRow) return true;
    const rowTerminal =
      row.row.kind === 'message_turn' && TERMINAL_ROW_PHASES.has(row.row.phase);
    const winNonTerminal =
      winRow.row.kind === 'message_turn' &&
      !TERMINAL_ROW_PHASES.has(winRow.row.phase);
    if (rowTerminal && winNonTerminal) {
      return true;
    }
    return toBigInt(row.revision) > toBigInt(winRow.revision);
  });
  return { liveRows: nextLiveRows, liveText };
}
