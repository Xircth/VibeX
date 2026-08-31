import type {
  ContentBlock,
  ConversationTimeline,
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
  children: ActivitySpan[];
};

function previewText(text: string, limit = 48): string {
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

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationOf(turn: MessageTurn): number {
  if (turn.duration_ms != null) {
    return Number(turn.duration_ms);
  }
  return 0;
}

function toolLabel(block: Extract<ContentBlock, { type: 'tool_use' }>): string {
  return block.tool_name || block.kind || 'tool';
}

export function activitySpansFromTimeline(
  timeline: ConversationTimeline | null | undefined
): ActivitySpan[] {
  const rows = timeline?.rows ?? [];
  const turns = rows.flatMap((row) =>
    row.row.kind === 'message_turn' ? [row.row.turn] : []
  );
  return activitySpansFromTurns(turns);
}

export function activitySpansFromTurns(turns: MessageTurn[]): ActivitySpan[] {
  const spans: ActivitySpan[] = [];

  for (const turn of turns) {
    const startMs = timestampMs(turn.timestamp);
    const durationMs = Math.max(durationOf(turn), 1);
    if (turn.role === 'user') {
      spans.push({
        id: turn.id,
        label: previewText(turnText(turn) || 'User'),
        kind: 'user',
        startMs,
        durationMs,
        children: [],
      });
      continue;
    }

    const tools = turn.blocks.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
        block.type === 'tool_use'
    );
    const childDuration =
      tools.length > 0 ? Math.max(1, Math.floor(durationMs / tools.length)) : 0;
    const children: ActivitySpan[] = tools.map((block, index) => ({
      id: `${turn.id}:tool:${block.tool_use_id ?? index}`,
      label: toolLabel(block),
      kind:
        block.meta && typeof block.meta === 'object' ? 'delegation' : 'tool',
      startMs: startMs + index * childDuration,
      durationMs: childDuration,
      children: [],
    }));
    const output = turnText(turn);
    if (output) {
      children.push({
        id: `${turn.id}:output`,
        label: previewText(output),
        kind: 'output',
        startMs: startMs + Math.max(0, durationMs - childDuration),
        durationMs: Math.max(childDuration, 1),
        children: [],
      });
    }

    spans.push({
      id: turn.id,
      label: previewText(output) || 'Assistant',
      kind: 'assistant',
      startMs,
      durationMs,
      children,
    });
  }

  return spans;
}

export function activityNoticesFromRows(rows: TimelineRow[]): string[] {
  const notices: string[] = [];
  for (const row of rows) {
    if (row.row.kind === 'session_notice') {
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
  if (spans.length === 0) {
    return { startMs: 0, endMs: 1 };
  }
  const startMs = Math.min(...spans.map((span) => span.startMs));
  const endMs = Math.max(
    ...spans.map((span) => span.startMs + span.durationMs)
  );
  return { startMs, endMs: Math.max(endMs, startMs + 1) };
}
