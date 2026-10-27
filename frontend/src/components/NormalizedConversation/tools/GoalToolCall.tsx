import { useCallback, useState, useSyncExternalStore } from 'react';
import { Flag, Loader2, Pause, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ConversationSessionGoal,
  GoalControlReceipt,
  NormalizedEntry,
  ToolResult,
} from 'shared/types';
import type { ProcessStartPayload } from '@/types/logs';
import type { ToolDisplayEntry } from '../messageTurnTool';
import { useExpandable } from '@/stores/useExpandableStore';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  getConversationBindReady,
  getConversationSessionGoal,
  subscribeConversationTimeline,
} from '@/features/conversation/conversationTimelineRegistry';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/modals';
import {
  formatGoalDuration,
  formatGoalTokens,
  isLimitedGoalStatus,
  normalizeSessionGoalStatus,
  parseConversationSessionGoal,
  type SessionGoalStatus,
} from '@/lib/sessionGoal';
import { sessionGoalStatusDotClass } from '../conversation/SessionGoalBar';
import { ToolCardShell } from './ToolCardShell';

const GOAL_TOOL_NAMES = new Set(['creategoal', 'updategoal']);

function normalizeToolName(value: string): string {
  return value
    .replace(/^(?:mcp|call|tool)[_:-]+/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function isGoalToolUse(use: {
  tool_name: string;
  tool_use_id?: string | null;
}): boolean {
  const canonical = normalizeToolName(use.tool_name);
  if (GOAL_TOOL_NAMES.has(canonical) || canonical.startsWith('codexgoal')) {
    return true;
  }
  const id = use.tool_use_id ?? '';
  return id.startsWith('codex-goal');
}

function isNormalizedEntry(
  entry: NormalizedEntry | ProcessStartPayload
): entry is ToolDisplayEntry {
  return 'entry_type' in entry;
}

export function isGoalToolEntry(
  entry: NormalizedEntry | ProcessStartPayload
): entry is ToolDisplayEntry {
  if (!isNormalizedEntry(entry)) return false;
  if (entry.entry_type.type !== 'tool_use') return false;
  return isGoalToolUse({
    tool_name: entry.entry_type.tool_name,
    tool_use_id: entry.toolUseId,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'bigint' && value >= 0n) {
      return Number(value);
    }
  }
  return null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function resultRecord(
  result: ToolResult | null | undefined
): Record<string, unknown> | null {
  if (!result) return null;
  const root = parseJsonRecord(result.value);
  if (!root) return null;
  return asRecord(root.result) ?? asRecord(root.data) ?? root;
}

interface GoalCardModel {
  action: 'create' | 'update';
  objective: string;
  status: SessionGoalStatus;
  summary: string | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
  tokensRemaining: number | null;
  durationMs: number | null;
}

function buildGoalModel(entry: ToolDisplayEntry): GoalCardModel | null {
  if (entry.entry_type.type !== 'tool_use') return null;
  const toolEntry = entry.entry_type;
  const toolName = normalizeToolName(toolEntry.tool_name);
  const action: 'create' | 'update' =
    toolName === 'creategoal' ? 'create' : 'update';
  const args =
    parseJsonRecord(entry.toolArguments) ??
    (toolEntry.action_type.action === 'tool'
      ? parseJsonRecord(toolEntry.action_type.arguments)
      : null);
  const output =
    resultRecord(entry.toolResult) ??
    (toolEntry.action_type.action === 'tool'
      ? resultRecord(toolEntry.action_type.result)
      : null);
  const metaRecord = parseJsonRecord(entry.toolMeta);
  const metaGoal =
    asRecord(metaRecord?.goal) ??
    asRecord(asRecord(asRecord(metaRecord?.jetbrains)?.air)?.goal) ??
    asRecord(asRecord(metaRecord?.codex)?.goal);

  const objective =
    readString(output, 'objective', 'goal', 'title', 'description', 'text') ??
    readString(args, 'objective', 'goal', 'title', 'description', 'text') ??
    readString(metaGoal, 'objective', 'goal', 'title', 'description', 'text') ??
    (entry.content.trim() || null);
  if (!objective) return null;

  const summary =
    readString(
      output,
      'summary',
      'progress',
      'note',
      'status_text',
      'message'
    ) ??
    readString(args, 'summary', 'progress', 'note', 'status_text', 'message') ??
    readString(metaGoal, 'summary', 'message', 'reason');

  const rawStatus =
    readString(output, 'status', 'state') ??
    readString(args, 'status', 'state') ??
    readString(metaGoal, 'status', 'state') ??
    (toolEntry.status.status === 'failed' ||
    toolEntry.status.status === 'denied' ||
    toolEntry.status.status === 'timed_out'
      ? 'failed'
      : toolEntry.status.status === 'created'
        ? 'active'
        : action === 'create'
          ? 'active'
          : 'completed');

  const status = normalizeSessionGoalStatus(rawStatus);
  const tokensUsed =
    readNumber(output, 'tokensUsed', 'tokens_used') ??
    readNumber(args, 'tokensUsed', 'tokens_used') ??
    readNumber(metaGoal, 'tokensUsed', 'tokens_used');
  const tokenBudget =
    readNumber(output, 'tokenBudget', 'token_budget') ??
    readNumber(args, 'tokenBudget', 'token_budget') ??
    readNumber(metaGoal, 'tokenBudget', 'token_budget');
  const tokensRemaining =
    readNumber(output, 'tokensRemaining', 'tokens_remaining') ??
    readNumber(args, 'tokensRemaining', 'tokens_remaining') ??
    readNumber(metaGoal, 'tokensRemaining', 'tokens_remaining');
  const durationMs =
    readNumber(output, 'durationMs', 'duration_ms') ??
    readNumber(args, 'durationMs', 'duration_ms') ??
    readNumber(metaGoal, 'durationMs', 'duration_ms');

  return {
    action,
    objective,
    status,
    summary: summary && summary !== objective ? summary : null,
    tokensUsed,
    tokenBudget,
    tokensRemaining,
    durationMs,
  };
}

function goalStatusToChatStatus(status: SessionGoalStatus) {
  switch (status) {
    case 'active':
      return 'running' as const;
    case 'paused':
      return 'pending' as const;
    case 'completed':
      return 'complete' as const;
    default:
      return 'error' as const;
  }
}

export function GoalToolCall({
  entry,
  expansionKey = 'goal-tool-call',
  sessionId,
  sessionGoal: sessionGoalProp,
  sessionBindReady: sessionBindReadyProp,
  onGoalControl: onGoalControlProp,
  onExpandedChange,
}: {
  entry: ToolDisplayEntry;
  expansionKey?: string;
  sessionId?: string | null;
  sessionGoal?: ConversationSessionGoal | null;
  sessionBindReady?: boolean;
  onGoalControl?: (action: 'pause' | 'clear') => Promise<GoalControlReceipt>;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation('conversation');
  const [expanded, setExpanded] = useExpandable(
    `goal-tool-entry:${expansionKey}`,
    false
  );
  const [pendingAction, setPendingAction] = useState<'pause' | 'clear' | null>(
    null
  );
  const storeSessionGoal = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationSessionGoal(sessionId ?? null),
    () => getConversationSessionGoal(sessionId ?? null)
  );
  const storeBindReady = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationBindReady(sessionId ?? null),
    () => getConversationBindReady(sessionId ?? null)
  );

  const sessionGoal =
    sessionGoalProp !== undefined ? sessionGoalProp : storeSessionGoal;
  const sessionBindReady =
    sessionBindReadyProp !== undefined ? sessionBindReadyProp : storeBindReady;
  const onGoalControl = useCallback(
    (action: 'pause' | 'clear') => {
      if (onGoalControlProp) return onGoalControlProp(action);
      if (sessionId) return conversationApi.goalControl(sessionId, action);
      return Promise.resolve({
        action,
        method: '_session/goal',
        should_interrupt_turn: false,
      });
    },
    [onGoalControlProp, sessionId]
  );
  const hasGoalControl = Boolean(onGoalControlProp || sessionId);

  const model = buildGoalModel(entry);
  const liveGoal = parseConversationSessionGoal(sessionGoal, {
    sessionBindReady: sessionBindReady && hasGoalControl,
  });

  const handleAction = useCallback(
    async (action: 'pause' | 'clear') => {
      if (!hasGoalControl || pendingAction !== null) return;
      setPendingAction(action);
      try {
        await onGoalControl(action);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [hasGoalControl, onGoalControl, pendingAction]
  );

  if (!model) return null;

  const isLiveMatchingGoal =
    liveGoal != null &&
    liveGoal.objective === model.objective &&
    (liveGoal.status === 'active' || liveGoal.status === 'paused');

  const effectiveStatus = isLiveMatchingGoal ? liveGoal.status : model.status;
  const effectiveTokensUsed =
    (isLiveMatchingGoal ? liveGoal.tokensUsed : null) ?? model.tokensUsed;
  const effectiveTokenBudget =
    (isLiveMatchingGoal ? liveGoal.tokenBudget : null) ?? model.tokenBudget;
  const effectiveTokensRemaining =
    (isLiveMatchingGoal ? liveGoal.tokensRemaining : null) ??
    model.tokensRemaining;
  const effectiveDurationMs =
    (isLiveMatchingGoal ? liveGoal.durationMs : null) ?? model.durationMs;
  const effectiveSummary =
    (isLiveMatchingGoal ? liveGoal.summary : null) ?? model.summary;

  const canPause = Boolean(isLiveMatchingGoal && liveGoal?.canPause);
  const canClear = Boolean(isLiveMatchingGoal && liveGoal?.canClear);

  const statusLabel =
    effectiveStatus === 'active'
      ? t('sessionGoal.status.active')
      : effectiveStatus === 'paused'
        ? t('sessionGoal.status.paused')
        : effectiveStatus === 'completed'
          ? t('sessionGoal.status.completed')
          : isLimitedGoalStatus(effectiveStatus)
            ? t('sessionGoal.status.limited')
            : t('sessionGoal.status.failed');

  const cardTitle = t('goalTool.cardTitle', { objective: model.objective });

  return (
    <div
      data-testid="goal-tool-call"
      data-goal-tool-call=""
      data-goal-status={effectiveStatus}
    >
      <ToolCardShell
        icon={<Flag className="h-3.5 w-3.5" aria-hidden="true" />}
        label={cardTitle}
        chatStatus={goalStatusToChatStatus(effectiveStatus)}
        expanded={expanded}
        expandable
        onToggle={() => {
          const next = !expanded;
          onExpandedChange?.(next);
          setExpanded(next);
        }}
      >
        <div className="mt-1 rounded-lg border border-border bg-card/80 px-3 py-2.5 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    sessionGoalStatusDotClass(effectiveStatus)
                  )}
                  aria-hidden="true"
                />
                <span className="font-medium text-foreground/90">
                  {statusLabel}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs font-medium text-foreground">
                {model.objective}
              </p>
              {effectiveSummary ? (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {effectiveSummary}
                </p>
              ) : null}
            </div>

            {canPause || canClear ? (
              <div className="flex shrink-0 items-center gap-1">
                {canPause ? (
                  <button
                    type="button"
                    data-testid="goal-tool-call-pause"
                    aria-label={t('sessionGoal.pauseAria')}
                    title={t('sessionGoal.pause')}
                    disabled={pendingAction !== null}
                    onClick={() => {
                      void handleAction('pause');
                    }}
                    className="composer-icon-control inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    {pendingAction === 'pause' ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                ) : null}
                {canClear ? (
                  <button
                    type="button"
                    data-testid="goal-tool-call-clear"
                    aria-label={t('sessionGoal.clearAria')}
                    title={t('sessionGoal.clear')}
                    disabled={pendingAction !== null}
                    onClick={() => {
                      void handleAction('clear');
                    }}
                    className="composer-icon-control inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    {pendingAction === 'clear' ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {effectiveTokensUsed != null ||
          effectiveTokenBudget != null ||
          effectiveTokensRemaining != null ||
          effectiveDurationMs != null ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 tabular-nums text-xs text-muted-foreground">
              {effectiveTokensUsed != null ? (
                <span>
                  {t('sessionGoal.tokensUsedLabel', {
                    tokens: formatGoalTokens(effectiveTokensUsed),
                  })}
                </span>
              ) : null}
              {effectiveTokenBudget != null ? (
                <span>
                  {t('sessionGoal.tokenBudgetLabel', {
                    tokens: formatGoalTokens(effectiveTokenBudget),
                  })}
                </span>
              ) : null}
              {effectiveTokensRemaining != null ? (
                <span>
                  {t('sessionGoal.tokensRemainingLabel', {
                    tokens: formatGoalTokens(effectiveTokensRemaining),
                  })}
                </span>
              ) : null}
              {effectiveDurationMs != null ? (
                <span>
                  {t('sessionGoal.durationLabel', {
                    duration: formatGoalDuration(effectiveDurationMs),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </ToolCardShell>
    </div>
  );
}

export default GoalToolCall;
