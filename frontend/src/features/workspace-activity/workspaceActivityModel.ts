import {
  getToolCallDescription,
  getToolSummary,
} from '@/components/NormalizedConversation/conversation-entry-utils';
import { isResendColdStartNotice } from '@/features/conversation/sessionNoticeNeedsRebind';
import { toolBlockToNormalizedEntry } from '@/components/NormalizedConversation/messageTurnTool';
import i18n from '@/i18n';
import type { TerminalSession } from '@/stores/useTerminalStore';
import type {
  ContentBlock,
  ConversationTimeline,
  ExecutionProcess,
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

export type ActivityBackgroundTaskKind = 'terminal' | 'delegation' | 'process';

export type ActivityBackgroundTask = {
  id: string;
  kind: ActivityBackgroundTaskKind;
  label: string;
  subtitle: string | null;
  detail: string;
  tabId?: string;
  sessionId?: string;
};

export type ActivityNoticeSeverity = 'error' | 'warning';

export type ActivityNoticeItem = {
  id: string;
  severity: ActivityNoticeSeverity;
  title: string;
  message: string;
  sessionId?: string | null;
  sessionName?: string | null;
};

export type LiveAgentTerminalItem = {
  terminalId: string;
  agentSessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
};

export type SessionTimelineSource = {
  sessionId: string;
  sessionName: string;
  turns: MessageTurn[];
  rows: TimelineRow[];
  failedTurnIds?: string[];
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

export function formatDurationMs(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 1_000) {
    return `${Math.round(safe)}ms`;
  }
  if (safe < 10_000) {
    return `${(safe / 1_000).toFixed(2).replace(/\.?0+$/, '')}s`;
  }
  if (safe < 60_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  }
  const totalSeconds = Math.round(safe / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function processReasonLabel(reason: string): string {
  switch (reason) {
    case 'devserver':
      return i18n.t('panels:workspaceActivity.processDevServer');
    case 'setupscript':
      return i18n.t('panels:workspaceActivity.processSetupScript');
    case 'cleanupscript':
      return i18n.t('panels:workspaceActivity.processCleanupScript');
    case 'archivescript':
      return i18n.t('panels:workspaceActivity.processArchiveScript');
    case 'codingagent':
      return i18n.t('panels:workspaceActivity.processCodingAgent');
    default:
      return reason;
  }
}

export function collectWorkspaceBackgroundTasks({
  terminalSessions = [],
  liveAgentTerminals = [],
  executionProcesses = [],
  sessionTimelines = [],
}: {
  terminalSessions?: Array<
    Pick<
      TerminalSession,
      'tabId' | 'sessionId' | 'title' | 'shell' | 'source' | 'busy'
    > & {
      cwd?: string | null;
      shellLabel?: string | null;
      agentSessionId?: string;
    }
  >;
  liveAgentTerminals?: LiveAgentTerminalItem[];
  executionProcesses?: ExecutionProcess[];
  sessionTimelines?: SessionTimelineSource[];
}): ActivityBackgroundTask[] {
  const tasks: ActivityBackgroundTask[] = [];
  const seenIds = new Set<string>();
  const runningLabel = i18n.t('panels:workspaceActivity.running');

  for (const session of terminalSessions) {
    if (session.source !== 'acp' && !session.busy) continue;
    seenIds.add(session.tabId);
    if (session.sessionId) {
      seenIds.add(`acp:${session.sessionId}`);
    }
    tasks.push({
      id: session.tabId,
      kind: 'terminal',
      label: session.title,
      subtitle:
        session.cwd?.trim() ||
        session.shellLabel?.trim() ||
        session.shell?.trim() ||
        null,
      detail: runningLabel,
      tabId: session.tabId,
      sessionId: session.agentSessionId,
    });
  }

  for (const live of liveAgentTerminals) {
    const tabKey = `acp:${live.terminalId}`;
    if (seenIds.has(tabKey)) continue;
    seenIds.add(tabKey);
    const command = [live.command, ...(live.args ?? [])]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
    if (!command) continue;
    tasks.push({
      id: tabKey,
      kind: 'terminal',
      label: previewText(command),
      subtitle: live.cwd?.trim() || null,
      detail: runningLabel,
      sessionId: live.agentSessionId,
    });
  }

  for (const timeline of sessionTimelines) {
    for (const turn of timeline.turns) {
      const completedTools = new Set<string>();
      for (const block of turn.blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          completedTools.add(block.tool_use_id);
        }
      }
      turn.blocks.forEach((block, index) => {
        if (block.type !== 'tool_use') return;
        const toolId = block.tool_use_id ?? `${turn.id}:${index}`;
        if (completedTools.has(toolId) || block.ended_at != null) return;
        if (!isDelegation(block.meta) && block.started_at == null) return;
        if (!isDelegation(block.meta)) return;
        const id = `delegation:${timeline.sessionId}:${toolId}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        tasks.push({
          id,
          kind: 'delegation',
          label: activityToolLabel(block, null),
          subtitle: timeline.sessionName,
          detail: runningLabel,
          sessionId: timeline.sessionId,
        });
      });
    }
  }

  for (const process of executionProcesses) {
    if (process.dropped || process.status !== 'running') continue;
    if (
      process.run_reason !== 'devserver' &&
      process.run_reason !== 'setupscript' &&
      process.run_reason !== 'cleanupscript' &&
      process.run_reason !== 'archivescript'
    ) {
      continue;
    }
    if (seenIds.has(process.id)) continue;
    seenIds.add(process.id);
    tasks.push({
      id: process.id,
      kind: 'process',
      label: processReasonLabel(process.run_reason),
      subtitle: null,
      detail: runningLabel,
      sessionId: process.session_id,
    });
  }

  return tasks;
}

export function collectWorkspaceActivityNotices({
  sessions = [],
  sessionTimelines = [],
  executionProcesses = [],
}: {
  sessions?: Array<{ id: string; fullName: string; isErrored?: boolean }>;
  sessionTimelines?: SessionTimelineSource[];
  executionProcesses?: ExecutionProcess[];
}): ActivityNoticeItem[] {
  const items: ActivityNoticeItem[] = [];
  const seenKeys = new Set<string>();
  const sessionsWithItems = new Set<string>();

  const pushNotice = (item: ActivityNoticeItem) => {
    const dedupKey = `${item.sessionId ?? ''}:${item.severity}:${item.title}:${item.message}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
    if (item.sessionId) {
      sessionsWithItems.add(item.sessionId);
    }
    items.push(item);
  };

  for (const timeline of sessionTimelines) {
    const turnIdsWithError = new Set<string>();
    const failedTurnSet = new Set(timeline.failedTurnIds ?? []);

    for (const row of timeline.rows) {
      if (row.row.kind === 'message_turn' && row.row.phase === 'failed') {
        failedTurnSet.add(row.row.turn.id);
      } else if (row.row.kind === 'session_notice') {
        if (isResendColdStartNotice(row.row_id, row.row.notice)) continue;
        const message =
          row.row.notice.message?.trim() || row.row.notice.title.trim();
        if (!message) continue;
        pushNotice({
          id: `${timeline.sessionId}:${row.row_id}`,
          severity: row.row.notice.severity === 'error' ? 'error' : 'warning',
          title: row.row.notice.title.trim() || timeline.sessionName,
          message,
          sessionId: timeline.sessionId,
          sessionName: timeline.sessionName,
        });
      } else if (row.row.kind === 'turn_error') {
        if (row.row.error.turn_id) {
          turnIdsWithError.add(row.row.error.turn_id);
        }
        const message = row.row.error.error.message.trim();
        if (!message) continue;
        pushNotice({
          id: `${timeline.sessionId}:${row.row_id}`,
          severity: 'error',
          title:
            row.row.error.error.code?.trim() ||
            i18n.t('panels:workspaceActivity.errorLabel'),
          message,
          sessionId: timeline.sessionId,
          sessionName: timeline.sessionName,
        });
      }
    }

    for (const turn of timeline.turns) {
      if (failedTurnSet.has(turn.id) && !turnIdsWithError.has(turn.id)) {
        pushNotice({
          id: `${timeline.sessionId}:turn-failed:${turn.id}`,
          severity: 'error',
          title: i18n.t('panels:workspaceActivity.errorLabel'),
          message: previewText(
            turnText(turn) ||
              i18n.t('panels:workspaceActivity.turnFailedFallback'),
            120
          ),
          sessionId: timeline.sessionId,
          sessionName: timeline.sessionName,
        });
      }

      const toolUses = new Map<
        string,
        Extract<ContentBlock, { type: 'tool_use' }>
      >();
      for (const block of turn.blocks) {
        if (block.type === 'tool_use' && block.tool_use_id) {
          toolUses.set(block.tool_use_id, block);
        }
      }

      turn.blocks.forEach((block, index) => {
        if (block.type !== 'tool_result' || !block.is_error) return;
        const matchingUse = block.tool_use_id
          ? (toolUses.get(block.tool_use_id) ?? null)
          : null;
        const title = matchingUse
          ? activityToolLabel(matchingUse, block)
          : i18n.t('app:turnTool.toolCall');
        const rawMessage = (block.output_preview ?? '').trim();
        pushNotice({
          id: `${timeline.sessionId}:tool-err:${turn.id}:${block.tool_use_id ?? index}`,
          severity: 'warning',
          title,
          message: previewText(
            rawMessage || i18n.t('panels:workspaceActivity.failed'),
            140
          ),
          sessionId: timeline.sessionId,
          sessionName: timeline.sessionName,
        });
      });
    }
  }

  for (const process of executionProcesses) {
    if (process.dropped) continue;
    if (process.status !== 'failed' && process.status !== 'killed') continue;
    const label = processReasonLabel(process.run_reason);
    const statusLabel =
      process.status === 'killed'
        ? i18n.t('panels:workspaceActivity.killed')
        : i18n.t('panels:workspaceActivity.failed');
    const exitDetail =
      process.exit_code != null
        ? i18n.t('panels:workspaceActivity.exitCode', {
            code: String(process.exit_code),
          })
        : null;
    pushNotice({
      id: `process:${process.id}`,
      severity: process.status === 'failed' ? 'error' : 'warning',
      title: label,
      message: exitDetail ? `${statusLabel}（${exitDetail}）` : statusLabel,
      sessionId: process.session_id,
      sessionName: null,
    });
  }

  for (const session of sessions) {
    if (!session.isErrored || sessionsWithItems.has(session.id)) continue;
    pushNotice({
      id: `session-errored:${session.id}`,
      severity: 'error',
      title: session.fullName,
      message: i18n.t('panels:workspaceActivity.sessionErrorFallback'),
      sessionId: session.id,
      sessionName: session.fullName,
    });
  }

  return items;
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
