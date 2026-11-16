import type {
  AgentSessionConfigOption,
  AgentSessionConfigOverride,
  ConversationPermissionView,
  MessageTurn,
  PlanEntry,
  TimelineRow,
  TokenUsageInfo,
} from 'shared/types';
import type { ContextCompactPresentation } from '@/components/NormalizedConversation/MessageTurnView';
import { planTurnBlocks } from '@/components/NormalizedConversation/messageTurnBlocks';
import { toolBlockToNormalizedEntry } from '@/components/NormalizedConversation/messageTurnTool';
import {
  splitDisplayContentImages,
  splitUserTurnContent,
} from '@/components/NormalizedConversation/userMessageImages';
import {
  getSessionComposerFileRefs,
  getSessionComposerPluginActionInvocations,
  serializeSessionComposerBackendMessage,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import type { PatchTypeWithKey } from '@/hooks/conversationEntries';
import type { ConversationMessageNavEntry } from './thread/messageNavEntries';
import {
  asFiniteNumber,
  turnTokenTotal,
  type TurnStatsData,
} from './thread/turnStatsModel';
import type {
  ConversationSessionModesState,
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

export function dimoTurnIdFromTimelineRowId(rowId: string): string {
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
    const baseId = dimoTurnIdFromTimelineRowId(row.turn.id);
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
  const baseId = dimoTurnIdFromTimelineRowId(row.turn.id);
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
      const baseId = dimoTurnIdFromTimelineRowId(row.turn.id);
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

function permissionDetailObject(
  details: ConversationPermissionView['details']
): Record<string, unknown> | null {
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

function readPermissionStringFromRecord(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readPermissionString(
  permission: ConversationPermissionView,
  ...keys: string[]
): string | null {
  const details = permissionDetailObject(permission.details);
  const fields =
    details?.fields &&
    typeof details.fields === 'object' &&
    !Array.isArray(details.fields)
      ? (details.fields as Record<string, unknown>)
      : null;
  const topLevel = permission as unknown as Record<string, unknown>;
  for (const source of [fields, details, topLevel]) {
    const found = readPermissionStringFromRecord(source, ...keys);
    if (found) return found;
  }
  return null;
}

export function timelineToPatchEntries(
  timeline: ConversationTimelineTurn[],
  sideRows: TimelineRow[],
  pendingPermissions: ConversationPermissionView[]
): PatchTypeWithKey[] {
  const result: PatchTypeWithKey[] = [];
  const pendingByToolId = new Map<string, ConversationPermissionView>();
  for (const permission of pendingPermissions) {
    const toolCallId = readPermissionString(
      permission,
      'toolCallId',
      'tool_call_id',
      'toolUseId',
      'tool_use_id'
    );
    if (toolCallId) {
      pendingByToolId.set(toolCallId, permission);
    }
  }
  const matchedPermissionIds = new Set<string>();

  for (const row of timeline) {
    const executionProcessId = row.turn.id;
    const timestamp = row.turn.timestamp ?? null;
    if (row.turn.role === 'user') {
      const { text } = splitUserTurnContent(row.turn.blocks);
      result.push({
        type: 'NORMALIZED_ENTRY',
        patchKey: `${row.key}:user`,
        executionProcessId,
        content: {
          timestamp,
          entry_type: { type: 'user_message' },
          content: text,
        },
      });
      continue;
    }

    const planned = planTurnBlocks(row.turn.blocks);
    planned.forEach((item, index) => {
      if (item.kind === 'markdown') {
        result.push({
          type: 'NORMALIZED_ENTRY',
          patchKey: `${row.key}:md:${index}`,
          executionProcessId,
          content: {
            timestamp,
            entry_type: { type: 'assistant_message' },
            content: item.text,
          },
        });
        return;
      }
      if (item.kind === 'tool' && item.use) {
        const entry = toolBlockToNormalizedEntry(
          item.use,
          item.result,
          timestamp
        );
        const pending = item.use.tool_use_id
          ? pendingByToolId.get(item.use.tool_use_id)
          : undefined;
        if (pending && entry.entry_type.type === 'tool_use') {
          matchedPermissionIds.add(pending.permission_id);
          entry.entry_type = {
            ...entry.entry_type,
            status: {
              status: 'pending_approval',
              approval_id: pending.permission_id,
              requested_at: timestamp ?? '',
              timeout_at: '',
            },
          };
        }
        result.push({
          type: 'NORMALIZED_ENTRY',
          patchKey: `${row.key}:tool:${index}`,
          executionProcessId,
          content: entry,
        });
      }
    });
  }

  for (const permission of pendingPermissions) {
    if (matchedPermissionIds.has(permission.permission_id)) continue;
    const toolName =
      readPermissionString(permission, 'toolName', 'tool_name') ?? 'tool';
    const label = permission.title?.trim() || toolName || 'Pending approval';
    result.push({
      type: 'NORMALIZED_ENTRY',
      patchKey: `perm:${permission.permission_id}`,
      executionProcessId: permission.permission_id,
      content: {
        timestamp: null,
        entry_type: {
          type: 'tool_use',
          tool_name: toolName,
          action_type: { action: 'other', description: label },
          status: {
            status: 'pending_approval',
            approval_id: permission.permission_id,
            requested_at: '',
            timeout_at: '',
          },
        },
        content: label,
      },
    });
  }

  for (const side of sideRows) {
    if (side.row.kind !== 'turn_error') continue;
    result.push({
      type: 'NORMALIZED_ENTRY',
      patchKey: `err:${side.row_id}`,
      executionProcessId: side.row.error.turn_id ?? side.row_id,
      content: {
        timestamp: null,
        entry_type: {
          type: 'error_message',
          error_type: { type: 'other' },
        },
        content: side.row.error.error.message,
      },
    });
  }

  return result;
}

export function buildResendTurnPayload({
  turn,
  replacementText,
  sessionModes,
  sessionConfigOptions,
}: {
  turn: MessageTurn;
  replacementText?: string;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
}): {
  text: string;
  displayText: string;
  images: string[];
  fileRefs: ReturnType<typeof getSessionComposerFileRefs>;
  workflowRefs: { pluginId: string; workflowId: string }[];
  modeOverride: string | null;
  configOverrides: AgentSessionConfigOverride[];
} | null {
  const parsedTurn = splitUserTurnContent(turn.blocks);
  const imageSet = new Set<string>();
  for (const attachment of [...parsedTurn.images, ...parsedTurn.files]) {
    const ref = attachment.path || attachment.sourceUrl;
    if (ref) imageSet.add(ref);
  }

  let displayText: string;
  if (replacementText !== undefined) {
    const parsedReplacement = splitDisplayContentImages(replacementText);
    displayText = parsedReplacement.text;
    for (const attachment of [
      ...parsedReplacement.images,
      ...parsedReplacement.files,
    ]) {
      const ref = attachment.path || attachment.sourceUrl;
      if (ref) imageSet.add(ref);
    }
  } else {
    displayText = parsedTurn.text;
  }

  const text = serializeSessionComposerBackendMessage(displayText).trim();
  const images = Array.from(imageSet);
  if (!text && !displayText.trim() && images.length === 0) {
    return null;
  }

  const fileRefs = getSessionComposerFileRefs(displayText);
  const workflowRefs = getSessionComposerPluginActionInvocations(
    displayText
  ).map((action) => ({
    pluginId: action.pluginId,
    workflowId: action.actionId,
  }));
  const modeOverride = sessionModes.current ?? null;
  const configOverrides: AgentSessionConfigOverride[] =
    sessionConfigOptions.flatMap((option) => {
      if (typeof option.value === 'string' && option.value.trim()) {
        return [{ key: option.key, value: option.value }];
      }
      if (
        typeof option.value === 'number' ||
        typeof option.value === 'boolean'
      ) {
        return [{ key: option.key, value: String(option.value) }];
      }
      return [];
    });

  return {
    text,
    displayText,
    images,
    fileRefs,
    workflowRefs,
    modeOverride,
    configOverrides,
  };
}
