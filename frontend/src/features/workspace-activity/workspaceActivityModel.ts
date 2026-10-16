import {
  getToolCallDescription,
  getToolSummary,
} from '@/components/NormalizedConversation/conversation-entry-utils';
import { isResendColdStartNotice } from '@/features/conversation/sessionNoticeNeedsRebind';
import { toolBlockToNormalizedEntry } from '@/components/NormalizedConversation/messageTurnTool';
import i18n from '@/i18n';
import type {
  ContentBlock,
  ConversationTimeline,
  JsonValue,
  MessageTurn,
  TimelineRow,
} from 'shared/types';

export type ActivitySpanKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'delegation'
  | 'output';

export type ActivitySpan = {
  id: string;
  label: string;
  kind: ActivitySpanKind;
  startMs: number;
  durationMs: number;
  /** False when the event has no stored start. The row stays; the bar does not. */
  timed: boolean;
  children: ActivitySpan[];
};

export type ActivityChart = {
  id: string;
  /** User message that opens this chart. Null only for events before the first one. */
  divider: string | null;
  spans: ActivitySpan[];
};

const OPAQUE_LABEL =
  /^(?:call_[A-Za-z0-9]{6,}|fc_[A-Za-z0-9]{6,}|tool[-_][A-Za-z0-9]{6,}|toolu_[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::\d+)?)$/i;

function previewText(text: string, limit = 72): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)}…`;
}

function turnText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .trim();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function turnEndMs(turn: MessageTurn): number | null {
  const completed = timestampMs(turn.completed_at);
  if (completed != null) return completed;
  const start = timestampMs(turn.timestamp);
  if (start != null && turn.duration_ms != null) {
    return start + Number(turn.duration_ms);
  }
  return null;
}

function isOpaqueLabel(value: string): boolean {
  return OPAQUE_LABEL.test(value.trim());
}

function isDelegation(meta: JsonValue | null | undefined): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return 'subagent' in meta || 'delegation' in meta || 'delegation_id' in meta;
}

function activityToolLabel(
  use: Extract<ContentBlock, { type: 'tool_use' }>,
  result: Extract<ContentBlock, { type: 'tool_result' }> | null
): string {
  const entry = toolBlockToNormalizedEntry(use, result, null);
  const description = getToolCallDescription(entry);
  if (description && !isOpaqueLabel(description)) {
    return previewText(description);
  }
  if (entry.entry_type.type !== 'tool_use') {
    return i18n.t('app:turnTool.toolCall');
  }
  const summary = getToolSummary(entry.entry_type, entry.content.trim());
  const label =
    summary.label && !isOpaqueLabel(summary.label) ? summary.label : '';
  const detail =
    summary.detail &&
    summary.detail !== summary.label &&
    !isOpaqueLabel(summary.detail)
      ? summary.detail
      : '';
  const combined = [label, detail].filter(Boolean).join(' ');
  if (combined) return previewText(combined);
  return i18n.t('app:turnTool.toolCall');
}

function toolWindow(
  block: Extract<ContentBlock, { type: 'tool_use' }>,
  turnEnd: number | null
): { startMs: number; durationMs: number } | null {
  const startMs = timestampMs(block.started_at);
  if (startMs == null) return null;
  const ended = timestampMs(block.ended_at);
  if (ended != null && ended >= startMs) {
    return { startMs, durationMs: Math.max(ended - startMs, 1) };
  }
  if (turnEnd != null && turnEnd >= startMs) {
    return { startMs, durationMs: Math.max(turnEnd - startMs, 1) };
  }
  return { startMs, durationMs: 1 };
}

function pushAssistantEvents(chart: ActivityChart, turn: MessageTurn) {
  const startMs = timestampMs(turn.timestamp) ?? 0;
  const endMs = turnEndMs(turn);
  const text = turnText(turn);
  if (text) {
    const timed = endMs != null && endMs >= startMs && startMs > 0;
    chart.spans.push({
      id: turn.id,
      label: previewText(text),
      kind: 'assistant',
      startMs: timed ? startMs : 0,
      durationMs: timed && endMs != null ? Math.max(endMs - startMs, 1) : 0,
      timed,
      children: [],
    });
  }

  const results = new Map<
    string,
    Extract<ContentBlock, { type: 'tool_result' }>
  >();
  for (const block of turn.blocks) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      results.set(block.tool_use_id, block);
    }
  }

  turn.blocks.forEach((block, index) => {
    if (block.type !== 'tool_use') return;
    const window = toolWindow(block, endMs);
    chart.spans.push({
      id: `${turn.id}:tool:${block.tool_use_id ?? index}`,
      label: activityToolLabel(
        block,
        block.tool_use_id ? (results.get(block.tool_use_id) ?? null) : null
      ),
      kind: isDelegation(block.meta) ? 'delegation' : 'tool',
      startMs: window?.startMs ?? 0,
      durationMs: window?.durationMs ?? 0,
      timed: window != null,
      children: [],
    });
  });
}

/** One Gantt chart per user message. The user text is the divider, not a bar. */
export function activityChartsFromTurns(turns: MessageTurn[]): ActivityChart[] {
  const charts: ActivityChart[] = [];
  let current: ActivityChart | null = null;

  for (const turn of turns) {
    if (turn.role === 'user') {
      current = {
        id: turn.id,
        divider: previewText(turnText(turn) || 'User'),
        spans: [],
      };
      charts.push(current);
      continue;
    }
    if (!current) {
      current = { id: `before-${turn.id}`, divider: null, spans: [] };
      charts.push(current);
    }
    pushAssistantEvents(current, turn);
  }

  return charts.filter(
    (chart) => chart.divider != null || chart.spans.length > 0
  );
}

export function activityChartsFromTimeline(
  timeline: ConversationTimeline | null | undefined
): ActivityChart[] {
  const rows = timeline?.rows ?? [];
  const turns = rows.flatMap((row) =>
    row.row.kind === 'message_turn' ? [row.row.turn] : []
  );
  return activityChartsFromTurns(turns);
}

export function activityNoticesFromRows(rows: TimelineRow[]): string[] {
  const notices: string[] = [];
  for (const row of rows) {
    if (row.row.kind === 'session_notice') {
      if (isResendColdStartNotice(row.row_id, row.row.notice)) continue;
      const text = row.row.notice.message?.trim() || row.row.notice.title;
      if (text) {
        notices.push(text);
      }
    }
    if (row.row.kind === 'turn_error') {
      notices.push(row.row.error.error.message);
    }
  }
  return notices;
}

export function spanWindow(spans: ActivitySpan[]): {
  startMs: number;
  endMs: number;
} {
  const timed = spans.filter((span) => span.timed);
  if (timed.length === 0) {
    return { startMs: 0, endMs: 1 };
  }
  const startMs = Math.min(...timed.map((span) => span.startMs));
  const endMs = Math.max(
    ...timed.map((span) => span.startMs + span.durationMs)
  );
  return { startMs, endMs: Math.max(endMs, startMs + 1) };
}
