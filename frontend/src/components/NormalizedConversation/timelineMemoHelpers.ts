import type {
  AgentSessionConfigOption,
  MessageTurn,
  PlanEntry,
  TokenUsageInfo,
} from 'shared/types';
import type { ContextCompactPresentation } from '@/components/NormalizedConversation/MessageTurnView';
import type { ConversationMessageNavEntry } from './thread/messageNavEntries';
import {
  asFiniteNumber,
  turnTokenTotal,
  type TurnStatsData,
} from './thread/turnStatsModel';
import type {
  ConversationTimelineItem,
  ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { isContextCompactPrompt } from '@/lib/contextCompact';

export const LOAD_OLDER_THRESHOLD_PX = 240;

export function timelineItemAsMessage(
  entry: ConversationTimelineTurn | ConversationTimelineItem
): ConversationTimelineTurn | null {
  if ('kind' in entry) {
    return entry.kind === 'message' ? entry.item : null;
  }
  return entry;
}

export function conversationThreadMaxWidthClass(
  _widthMode: 'bounded' | 'workspace' = 'bounded',
  _isEditorAreaVisible = true
): 'max-w-3xl' {
  void _widthMode;
  void _isEditorAreaVisible;
  return 'max-w-3xl';
}

export function shouldLoadOlderTimelinePage(input: {
  hasEarlier: boolean;
  isAtBottom: boolean;
  scrollTop: number;
  previousScrollTop: number;
}): boolean {
  const scrolledUpIntoOrWithinTopZone =
    input.scrollTop <= LOAD_OLDER_THRESHOLD_PX &&
    input.scrollTop < input.previousScrollTop;
  return input.hasEarlier && !input.isAtBottom && scrolledUpIntoOrWithinTopZone;
}

/** Nav dots derived from the timeline's user turns (one dot per user message). */
export function buildTimelineNavEntries(
  timeline: Array<ConversationTimelineTurn | ConversationTimelineItem>
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  let ordinal = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const row = timelineItemAsMessage(timeline[index]!);
    if (!row || row.turn.role !== 'user') continue;
    ordinal += 1;
    const rawText = extractTurnText(row.turn, ' ');
    const preview =
      rawText.trim().replace(/\s+/g, ' ').slice(0, 80) ||
      `User message ${ordinal}`;
    entries.push({
      key: row.key,
      index,
      ordinal,
      preview,
      additions: 0,
      deletions: 0,
    });
  }
  return entries;
}

export function vibexTurnIdFromTimelineRowId(rowId: string): string {
  return rowId.replace(/:(?:assistant(?::\d+)?|user)$/u, '');
}

export function isTimelineTurnInFlight(
  timeline: ConversationTimelineTurn[]
): boolean {
  return timeline.some((row) => {
    if (row.phase !== 'streaming' && row.phase !== 'optimistic') {
      return false;
    }
    if (row.turn.role !== 'assistant') {
      return true;
    }
    const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
    const userId = baseId !== row.turn.id ? `${baseId}:user` : null;
    if (!userId) {
      return true;
    }
    const user = timeline.find(
      (candidate) =>
        candidate.turn.role === 'user' && candidate.turn.id === userId
    );
    return !user || user.phase === 'streaming' || user.phase === 'optimistic';
  });
}

export function parseSideRowTurnAliases(rowId: string): {
  userTurnId: string | null;
  assistantTurnId: string | null;
} {
  let userTurnId: string | null = null;
  let assistantTurnId: string | null = null;
  for (const segment of rowId.split('|').slice(1)) {
    if (segment.startsWith('user=')) {
      userTurnId = segment.slice('user='.length) || null;
    } else if (segment.startsWith('assistant=')) {
      assistantTurnId = segment.slice('assistant='.length) || null;
    }
  }
  return { userTurnId, assistantTurnId };
}

export function getLatestTimelinePlanEntries(
  timeline: ConversationTimelineTurn[]
): PlanEntry[] {
  for (let r = timeline.length - 1; r >= 0; r -= 1) {
    const blocks = timeline[r]!.turn.blocks;
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b]!;
      if (block.type === 'plan') {
        return block.entries;
      }
      if (
        block.type === 'tool_use' &&
        (block.tool_name === 'TodoWrite' || block.tool_use_id === 'acp-plan') &&
        block.input_preview
      ) {
        try {
          const parsed = JSON.parse(block.input_preview) as {
            todos?: Array<{
              content?: string;
              status?: string;
              priority?: string;
            }>;
          };
          if (Array.isArray(parsed.todos)) {
            return parsed.todos
              .filter((todo) => typeof todo?.content === 'string')
              .map((todo) => ({
                content: todo.content ?? '',
                status: (todo.status ?? 'pending') as PlanEntry['status'],
                priority: (todo.priority ?? null) as PlanEntry['priority'],
              }));
          }
        } catch {
          // ignore malformed todo preview
        }
      }
    }
  }

  return [];
}

/** Only the latest user message offers edit-and-resend, including while its
 * assistant turn is still in flight. */
export function isEditableUserTimelineRow(
  row: ConversationTimelineTurn,
  lastUserRowKey: string | null
): boolean {
  return row.turn.role === 'user' && row.key === lastUserRowKey;
}

function extractTurnText(turn: MessageTurn, separator = '\n\n'): string {
  let first: string | null = null;
  let parts: string[] | null = null;
  for (const block of turn.blocks) {
    if (block.type !== 'text') continue;
    if (first === null) {
      first = block.text;
    } else if (parts === null) {
      parts = [first, block.text];
    } else {
      parts.push(block.text);
    }
  }
  if (parts !== null) return parts.join(separator);
  return first ?? '';
}

function buildContextCompactPresentation(
  row: ConversationTimelineTurn,
  userTurn: MessageTurn | undefined
): ContextCompactPresentation | null {
  if (row.turn.role !== 'assistant') return null;
  const prompt = userTurn ? extractTurnText(userTurn) : undefined;
  if (!isContextCompactPrompt(prompt)) return null;

  const status =
    row.phase === 'streaming' || row.phase === 'optimistic'
      ? 'running'
      : row.phase === 'failed' ||
          row.phase === 'cancelled' ||
          row.phase === 'interrupted'
        ? 'failed'
        : 'success';
  const usage = row.turn.usage;
  const contextTokens = usage
    ? Number(
        usage.context_used ??
          Number(usage.input_tokens) +
            Number(usage.output_tokens) +
            Number(usage.cache_creation_input_tokens) +
            Number(usage.cache_read_input_tokens)
      )
    : null;

  return {
    status,
    durationMs:
      row.turn.duration_ms != null ? Number(row.turn.duration_ms) : null,
    contextTokens:
      contextTokens != null && contextTokens > 0 ? contextTokens : null,
  };
}

export function contextCompactPresentationForRow(
  timeline: ConversationTimelineTurn[],
  index: number
): ContextCompactPresentation | null {
  const row = timeline[index];
  if (!row || row.turn.role !== 'assistant') return null;
  const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
  const targetUserId = `${baseId}:user`;
  let userTurn: MessageTurn | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = timeline[i];
    if (candidate?.turn.id === targetUserId) {
      userTurn = candidate.turn;
      break;
    }
    if (
      row.turn.id.startsWith('acp-') &&
      candidate?.turn.role === 'user' &&
      !candidate.turn.id.includes(':steer:')
    ) {
      userTurn = candidate.turn;
      break;
    }
  }
  return buildContextCompactPresentation(row, userTurn);
}

export function buildContextCompactPresentationByRowKey(
  timeline: ConversationTimelineTurn[]
): Map<string, ContextCompactPresentation | null> {
  const byRowKey = new Map<string, ContextCompactPresentation | null>();
  const latestTurnById = new Map<string, MessageTurn>();
  let lastNonSteerUserTurn: MessageTurn | undefined;

  for (const row of timeline) {
    if (row.turn.role === 'assistant') {
      const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
      const userTurn =
        latestTurnById.get(`${baseId}:user`) ??
        (row.turn.id.startsWith('acp-') ? lastNonSteerUserTurn : undefined);
      byRowKey.set(row.key, buildContextCompactPresentation(row, userTurn));
    } else {
      byRowKey.set(row.key, null);
      if (row.turn.role === 'user' && !row.turn.id.includes(':steer:')) {
        lastNonSteerUserTurn = row.turn;
      }
    }
    latestTurnById.set(row.turn.id, row.turn);
  }

  return byRowKey;
}

export function assistantCopyText(turn: MessageTurn): string {
  return extractTurnText(turn);
}

export function turnCopyText(turn: MessageTurn): string {
  return extractTurnText(turn).trim();
}

/**
 * Latest assistant-turn token usage for the composer's context-usage ring,
 * shaped from the agent-reported context window. Returns null (which hides the
 * indicator) unless a turn carries a real context_window_max — agents that
 * don't report a window simply don't show the ratio.
 */
export function latestTokenUsage(
  timeline: ConversationTimelineTurn[]
): TokenUsageInfo | null {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const turn = timeline[index]?.turn;
    const usage = turn?.usage;
    if (!turn || turn.role !== 'assistant' || !usage) continue;
    const window =
      usage.context_window_max != null ? Number(usage.context_window_max) : 0;
    if (window <= 0) continue;
    const breakdown =
      Number(usage.input_tokens) +
      Number(usage.output_tokens) +
      Number(usage.cache_creation_input_tokens) +
      Number(usage.cache_read_input_tokens);
    const total =
      usage.context_used != null ? Number(usage.context_used) : breakdown;
    if (total <= 0) continue;
    return { total_tokens: total, model_context_window: window };
  }
  return null;
}

export function usageWindow(usage: MessageTurn['usage']): number | null {
  const window = asFiniteNumber(usage?.context_window_max);
  return window !== null && window > 0 ? window : null;
}

export function buildLiveTurnStats(input: {
  timeline: ConversationTimelineTurn[];
  sessionConfigOptions?: AgentSessionConfigOption[];
}): TurnStatsData {
  let latestAssistant: ConversationTimelineTurn | undefined;
  for (let index = input.timeline.length - 1; index >= 0; index -= 1) {
    const row = input.timeline[index];
    if (row?.turn.role === 'assistant') {
      latestAssistant = row;
      break;
    }
  }
  const usage = latestAssistant?.turn.usage;
  let activeModel = latestAssistant?.turn.model?.trim() || null;

  if (!activeModel && input.sessionConfigOptions) {
    const modelOption = input.sessionConfigOptions.find(
      (option) => option.category === 'model' || option.key === 'model'
    );
    if (typeof modelOption?.value === 'string' && modelOption.value.trim()) {
      activeModel = modelOption.value.trim();
    }
  }

  return {
    model: activeModel,
    totalTokens: usage ? turnTokenTotal(usage) : null,
    contextWindow: usageWindow(usage),
  };
}

/** Turn stats for a settled assistant turn, sourced from the parsed MessageTurn. */
export function buildSettledTurnStats(turn: MessageTurn): TurnStatsData {
  const usage = turn.usage ?? null;
  return {
    model: turn.model ?? null,
    startedAt: turn.timestamp,
    totalTokens: turnTokenTotal(usage),
    contextWindow: usageWindow(usage),
    cacheReadTokens: asFiniteNumber(usage?.cache_read_input_tokens),
    cacheWriteTokens: asFiniteNumber(usage?.cache_creation_input_tokens),
    elapsedMs: asFiniteNumber(turn.duration_ms),
    completedAt: turn.completed_at ?? null,
    stopReason: null,
  };
}

export function mergeMissingTurnStats(
  settled: TurnStatsData,
  live: TurnStatsData
): TurnStatsData {
  return {
    ...settled,
    model: settled.model ?? live.model ?? null,
    totalTokens: settled.totalTokens ?? live.totalTokens ?? null,
    contextWindow: settled.contextWindow ?? live.contextWindow ?? null,
  };
}
