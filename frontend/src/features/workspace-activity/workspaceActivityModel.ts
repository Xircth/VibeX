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
  TurnUsage,
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

export type TrajectoryRecordKind =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'subtool'
  | 'notice';

export type TrajectoryLane = 0 | 1 | 2;

export type TrajectoryStatus = 'completed' | 'running' | 'failed';

export type TrajectoryTimelineMode = 'duration' | 'sequence';

export type TrajectoryTimeRange = {
  start: number;
  end: number;
};

export type TrajectoryUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextUsedTokens: number | null;
  contextWindowMaxTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
};

export type TrajectoryRecord = {
  id: string;
  index: number;
  turn: number | null;
  step: number;
  turnStart: boolean;
  turnEnd: boolean;
  kind: TrajectoryRecordKind;
  lane: TrajectoryLane;
  status: TrajectoryStatus;
  isError: boolean;
  title: string;
  resultPreview: string | null;
  fullText: string | null;
  thinkingText: string | null;
  toolName: string | null;
  inputDetail: string | null;
  outputDetail: string | null;
  model: string | null;
  parentAssistantIndex: number | null;
  childSessionId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  timed: boolean;
  usage: TrajectoryUsage | null;
  cumulativeUsage: TrajectoryUsage | null;
};

export type TrajectoryTimelineSpan = TrajectoryTimeRange & {
  index: number;
  lane: TrajectoryLane;
  kind: TrajectoryRecordKind;
  label: string;
  isError: boolean;
};

export type TrajectoryTimelineTurnBoundary = {
  turn: number;
  time: number;
};

export type TrajectoryTimelineModel = TrajectoryTimeRange & {
  spans: TrajectoryTimelineSpan[];
  turnBoundaries: TrajectoryTimelineTurnBoundary[];
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

function turnThinkingText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'thinking' ? [block.text] : []))
    .join('\n\n')
    .trim();
}

function toTrajectoryUsage(
  usage: TurnUsage | null | undefined
): TrajectoryUsage | null {
  if (!usage) return null;
  return {
    inputTokens: Number(usage.input_tokens ?? 0n),
    outputTokens: Number(usage.output_tokens ?? 0n),
    cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0n),
    cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0n),
    contextUsedTokens:
      usage.context_used != null ? Number(usage.context_used) : null,
    contextWindowMaxTokens:
      usage.context_window_max != null
        ? Number(usage.context_window_max)
        : null,
    costAmount: usage.cost_amount ?? null,
    costCurrency: usage.cost_currency ?? null,
  };
}

function mergeTrajectoryUsage(
  prev: TrajectoryUsage | null,
  next: TrajectoryUsage | null
): TrajectoryUsage | null {
  if (!next) return prev ? { ...prev } : null;
  if (!prev) return { ...next };
  return {
    inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: prev.cacheWriteTokens + next.cacheWriteTokens,
    contextUsedTokens: next.contextUsedTokens ?? prev.contextUsedTokens,
    contextWindowMaxTokens:
      next.contextWindowMaxTokens ?? prev.contextWindowMaxTokens,
    costAmount:
      prev.costAmount != null || next.costAmount != null
        ? (prev.costAmount ?? 0) + (next.costAmount ?? 0)
        : null,
    costCurrency: next.costCurrency ?? prev.costCurrency,
  };
}

function delegationChildSessionId(
  meta: JsonValue | null | undefined
): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, JsonValue>;
  const direct =
    record.child_conversation_id ??
    record.childConversationId ??
    record.session_id ??
    record.sessionId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (
    record.delegation &&
    typeof record.delegation === 'object' &&
    !Array.isArray(record.delegation)
  ) {
    const nested = (record.delegation as Record<string, JsonValue>)
      .child_conversation_id;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return null;
}

function finalizeTurnBoundaries(
  records: TrajectoryRecord[]
): TrajectoryRecord[] {
  const firstByTurn = new Map<number, number>();
  const lastByTurn = new Map<number, number>();

  records.forEach((record, idx) => {
    record.index = idx;
    record.turnStart = false;
    record.turnEnd = false;
    if (record.turn == null) return;
    if (!firstByTurn.has(record.turn)) {
      firstByTurn.set(record.turn, idx);
    }
    lastByTurn.set(record.turn, idx);
  });

  for (const idx of firstByTurn.values()) {
    if (records[idx]) records[idx].turnStart = true;
  }
  for (const idx of lastByTurn.values()) {
    if (records[idx]) records[idx].turnEnd = true;
  }
  return records;
}

export function buildTrajectoryRecords({
  turns = [],
  rows = [],
  charts = [],
  failedTurnIds = [],
}: {
  turns?: MessageTurn[];
  rows?: TimelineRow[];
  charts?: ActivityChart[];
  failedTurnIds?: string[];
}): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];

  if (turns.length === 0 && charts.length > 0) {
    charts.forEach((chart, chartIndex) => {
      const turnNum = chartIndex + 1;
      const firstTimed = chart.spans.find((s) => s.timed);
      if (chart.divider) {
        records.push({
          id: `${chart.id}:user`,
          index: records.length,
          turn: turnNum,
          step: 0,
          turnStart: false,
          turnEnd: false,
          kind: 'user',
          lane: 0,
          status: 'completed',
          isError: false,
          title: chart.divider,
          resultPreview: null,
          fullText: chart.divider,
          thinkingText: null,
          toolName: null,
          inputDetail: null,
          outputDetail: null,
          model: null,
          parentAssistantIndex: null,
          childSessionId: null,
          startedAtMs: firstTimed ? firstTimed.startMs : null,
          endedAtMs: firstTimed ? firstTimed.startMs : null,
          durationMs: 0,
          timed: Boolean(firstTimed),
          usage: null,
          cumulativeUsage: null,
        });
      }

      let lastAssistantIndex: number | null = null;
      let stepNum = 0;

      for (const span of chart.spans) {
        const isAssistant = span.kind === 'assistant';
        if (isAssistant) {
          stepNum += 1;
        }
        const kind: TrajectoryRecordKind =
          span.kind === 'assistant'
            ? 'assistant'
            : span.kind === 'delegation'
              ? 'subtool'
              : span.kind === 'tool'
                ? 'tool'
                : span.kind === 'user'
                  ? 'user'
                  : 'notice';
        const lane: TrajectoryLane =
          kind === 'tool' || kind === 'subtool'
            ? 2
            : kind === 'assistant'
              ? 1
              : 0;
        const recordIndex = records.length;
        if (isAssistant) {
          lastAssistantIndex = recordIndex;
        }
        records.push({
          id: span.id,
          index: recordIndex,
          turn: turnNum,
          step: Math.max(1, stepNum),
          turnStart: false,
          turnEnd: false,
          kind,
          lane,
          status: 'completed',
          isError: false,
          title: span.label,
          resultPreview: null,
          fullText: span.label,
          thinkingText: null,
          toolName: kind === 'tool' || kind === 'subtool' ? span.label : null,
          inputDetail: null,
          outputDetail: null,
          model: null,
          parentAssistantIndex:
            kind === 'tool' || kind === 'subtool' ? lastAssistantIndex : null,
          childSessionId: null,
          startedAtMs: span.timed ? span.startMs : null,
          endedAtMs: span.timed ? span.startMs + span.durationMs : null,
          durationMs: span.timed ? span.durationMs : null,
          timed: span.timed,
          usage: null,
          cumulativeUsage: null,
        });
      }
    });

    return finalizeTurnBoundaries(records);
  }

  const failedTurnSet = new Set(failedTurnIds);
  const turnErrorsByTurnId = new Map<string, string>();
  const standaloneNotices: Array<{
    id: string;
    title: string;
    message: string;
    isError: boolean;
  }> = [];

  for (const row of rows) {
    if (row.row.kind === 'message_turn' && row.row.phase === 'failed') {
      failedTurnSet.add(row.row.turn.id);
    } else if (row.row.kind === 'turn_error') {
      const msg = row.row.error.error.message.trim();
      if (row.row.error.turn_id && msg) {
        turnErrorsByTurnId.set(row.row.error.turn_id, msg);
      } else if (msg) {
        standaloneNotices.push({
          id: row.row_id,
          title:
            row.row.error.error.code?.trim() ||
            i18n.t('panels:workspaceActivity.errorLabel'),
          message: msg,
          isError: true,
        });
      }
    } else if (row.row.kind === 'session_notice') {
      if (isResendColdStartNotice(row.row_id, row.row.notice)) continue;
      const msg = row.row.notice.message?.trim() || row.row.notice.title.trim();
      if (msg) {
        standaloneNotices.push({
          id: row.row_id,
          title: row.row.notice.title.trim() || msg,
          message: msg,
          isError: row.row.notice.severity === 'error',
        });
      }
    }
  }

  let currentTurn = 0;
  let currentStep = 0;
  let cumulativeUsage: TrajectoryUsage | null = null;

  for (const turn of turns) {
    const startMs = timestampMs(turn.timestamp);
    const endMs = turnEndMs(turn);
    const text = turnText(turn);

    if (turn.role === 'system') {
      records.push({
        id: turn.id,
        index: records.length,
        turn: currentTurn > 0 ? currentTurn : null,
        step: 0,
        turnStart: false,
        turnEnd: false,
        kind: 'system',
        lane: 0,
        status: 'completed',
        isError: false,
        title: previewText(text || 'System', 96),
        resultPreview: null,
        fullText: text || null,
        thinkingText: null,
        toolName: null,
        inputDetail: null,
        outputDetail: null,
        model: turn.model ?? null,
        parentAssistantIndex: null,
        childSessionId: null,
        startedAtMs: startMs,
        endedAtMs: endMs ?? startMs,
        durationMs:
          startMs != null && endMs != null && endMs >= startMs
            ? endMs - startMs
            : 0,
        timed: startMs != null,
        usage: null,
        cumulativeUsage,
      });
      continue;
    }

    if (turn.role === 'user') {
      currentTurn += 1;
      currentStep = 0;
      const durationMs =
        startMs != null && endMs != null && endMs >= startMs
          ? endMs - startMs
          : 0;
      records.push({
        id: turn.id,
        index: records.length,
        turn: currentTurn,
        step: 0,
        turnStart: false,
        turnEnd: false,
        kind: 'user',
        lane: 0,
        status: 'completed',
        isError: false,
        title: previewText(text || 'User', 96),
        resultPreview: null,
        fullText: text || null,
        thinkingText: null,
        toolName: null,
        inputDetail: null,
        outputDetail: null,
        model: null,
        parentAssistantIndex: null,
        childSessionId: null,
        startedAtMs: startMs,
        endedAtMs: endMs ?? startMs,
        durationMs,
        timed: startMs != null,
        usage: null,
        cumulativeUsage,
      });
      continue;
    }

    if (currentTurn === 0) {
      currentTurn = 1;
    }
    currentStep += 1;

    const thinking = turnThinkingText(turn);
    const usage = toTrajectoryUsage(turn.usage);
    cumulativeUsage = mergeTrajectoryUsage(cumulativeUsage, usage);
    const turnErrorMsg = turnErrorsByTurnId.get(turn.id) ?? null;
    const isTurnFailed = failedTurnSet.has(turn.id) || turnErrorMsg != null;
    const timed = startMs != null && endMs != null && endMs >= startMs;
    const durationMs = timed ? Math.max(endMs - startMs, 1) : null;
    const hasToolCalls = turn.blocks.some((b) => b.type === 'tool_use');

    const assistantRecordIndex = records.length;
    const assistantTitle = text
      ? previewText(text, 96)
      : thinking
        ? previewText(thinking, 96)
        : hasToolCalls
          ? i18n.t('panels:workspaceActivity.trajectoryToolCallOnly')
          : turnErrorMsg
            ? previewText(turnErrorMsg, 96)
            : i18n.t('panels:workspaceActivity.kindAssistant');

    records.push({
      id: turn.id,
      index: assistantRecordIndex,
      turn: currentTurn,
      step: currentStep,
      turnStart: false,
      turnEnd: false,
      kind: 'assistant',
      lane: 1,
      status: isTurnFailed
        ? 'failed'
        : endMs == null && turn.duration_ms == null
          ? 'running'
          : 'completed',
      isError: isTurnFailed,
      title: assistantTitle,
      resultPreview: turnErrorMsg ? previewText(turnErrorMsg, 80) : null,
      fullText: text || null,
      thinkingText: thinking || null,
      toolName: null,
      inputDetail: null,
      outputDetail: turnErrorMsg,
      model: turn.model ?? null,
      parentAssistantIndex: null,
      childSessionId: null,
      startedAtMs: startMs,
      endedAtMs: endMs,
      durationMs,
      timed,
      usage,
      cumulativeUsage,
    });

    const resultsById = new Map<
      string,
      Extract<ContentBlock, { type: 'tool_result' }>
    >();
    for (const block of turn.blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        resultsById.set(block.tool_use_id, block);
      }
    }

    turn.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'tool_use') return;
      const matchingResult = block.tool_use_id
        ? (resultsById.get(block.tool_use_id) ?? null)
        : null;
      const window = toolWindow(block, endMs);
      const isSub = isDelegation(block.meta);
      const isToolError =
        Boolean(matchingResult?.is_error) ||
        block.status === 'failed' ||
        block.status === 'error';
      const isRunning =
        !isToolError && matchingResult == null && block.ended_at == null;
      const rawOutput = matchingResult?.output_preview?.trim() ?? null;
      const rawInput =
        block.input_preview?.trim() ||
        (block.meta ? JSON.stringify(block.meta, null, 2) : null);

      records.push({
        id: `${turn.id}:tool:${block.tool_use_id ?? blockIndex}`,
        index: records.length,
        turn: currentTurn,
        step: currentStep,
        turnStart: false,
        turnEnd: false,
        kind: isSub ? 'subtool' : 'tool',
        lane: 2,
        status: isToolError ? 'failed' : isRunning ? 'running' : 'completed',
        isError: isToolError,
        title: activityToolLabel(block, matchingResult),
        resultPreview: rawOutput ? previewText(rawOutput, 80) : null,
        fullText: null,
        thinkingText: null,
        toolName: block.tool_name,
        inputDetail: rawInput,
        outputDetail: rawOutput,
        model: turn.model ?? null,
        parentAssistantIndex: assistantRecordIndex,
        childSessionId: delegationChildSessionId(block.meta),
        startedAtMs: window?.startMs ?? null,
        endedAtMs: window != null ? window.startMs + window.durationMs : null,
        durationMs: window?.durationMs ?? null,
        timed: window != null,
        usage: null,
        cumulativeUsage,
      });
    });
  }

  for (const notice of standaloneNotices) {
    records.push({
      id: `notice:${notice.id}`,
      index: records.length,
      turn: currentTurn > 0 ? currentTurn : null,
      step: currentStep,
      turnStart: false,
      turnEnd: false,
      kind: 'notice',
      lane: 0,
      status: notice.isError ? 'failed' : 'completed',
      isError: notice.isError,
      title: previewText(notice.title, 72),
      resultPreview:
        notice.message !== notice.title
          ? previewText(notice.message, 80)
          : null,
      fullText: notice.message,
      thinkingText: null,
      toolName: null,
      inputDetail: null,
      outputDetail: notice.message,
      model: null,
      parentAssistantIndex: null,
      childSessionId: null,
      startedAtMs: null,
      endedAtMs: null,
      durationMs: null,
      timed: false,
      usage: null,
      cumulativeUsage,
    });
  }

  return finalizeTurnBoundaries(records);
}

export function deriveTrajectoryTimeline(
  records: readonly TrajectoryRecord[],
  mode: TrajectoryTimelineMode = 'sequence'
): TrajectoryTimelineModel | null {
  if (records.length === 0) return null;

  if (mode === 'duration') {
    const timedRecords = records.filter(
      (record) =>
        record.startedAtMs != null && Number.isFinite(record.startedAtMs)
    );
    if (timedRecords.length > 0) {
      const rawSpans = timedRecords.map((record) => {
        const start = record.startedAtMs!;
        const dur = Math.max(record.durationMs ?? 0, 50);
        return {
          index: record.index,
          turn: record.turn,
          start,
          end: start + dur,
          lane: record.lane,
          kind: record.kind,
          label: record.title,
          isError: record.isError,
        };
      });

      const removedIdleByIndex = new Map<number, number>();
      let removedIdle = 0;
      let coveredUntil: number | null = null;
      for (const span of [...rawSpans].sort(
        (a, b) => a.start - b.start || a.end - b.end
      )) {
        if (coveredUntil != null && span.start > coveredUntil) {
          removedIdle += span.start - coveredUntil;
        }
        removedIdleByIndex.set(span.index, removedIdle);
        coveredUntil =
          coveredUntil == null ? span.end : Math.max(coveredUntil, span.end);
      }

      const spans: TrajectoryTimelineSpan[] = rawSpans.map((span) => {
        const offset = removedIdleByIndex.get(span.index) ?? 0;
        return {
          index: span.index,
          start: span.start - offset,
          end: span.end - offset,
          lane: span.lane,
          kind: span.kind,
          label: span.label,
          isError: span.isError,
        };
      });

      const turnFirstTime = new Map<number, number>();
      rawSpans.forEach((raw, i) => {
        const projected = spans[i];
        if (!projected || raw.turn == null || raw.turn <= 1) return;
        const prev = turnFirstTime.get(raw.turn);
        if (prev == null || projected.start < prev) {
          turnFirstTime.set(raw.turn, projected.start);
        }
      });

      const start = Math.min(...spans.map((s) => s.start));
      const end = Math.max(start + 1, ...spans.map((s) => s.end));
      const turnBoundaries: TrajectoryTimelineTurnBoundary[] = Array.from(
        turnFirstTime.entries()
      )
        .map(([turn, time]) => ({ turn, time }))
        .filter((b) => b.time > start);

      return {
        start,
        end,
        spans,
        turnBoundaries,
      };
    }
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  const seenTurnBoundary = new Set<number>();

  records.forEach((record, offset) => {
    if (
      record.turn != null &&
      record.turn > 1 &&
      !seenTurnBoundary.has(record.turn)
    ) {
      seenTurnBoundary.add(record.turn);
      turnBoundaries.push({
        turn: record.turn,
        time: offset,
      });
    }
    spans.push({
      index: record.index,
      start: offset,
      end: offset + 1,
      lane: record.lane,
      kind: record.kind,
      label: record.title,
      isError: record.isError,
    });
  });

  return {
    start: 0,
    end: Math.max(1, spans.length),
    spans,
    turnBoundaries,
  };
}

export function trajectoryTimelineFocusIndexes(
  records: readonly TrajectoryRecord[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = 'sequence'
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(records, mode);
  if (!model) return new Set();
  const min = Math.min(range.start, range.end);
  const max = Math.max(range.start, range.end);
  return new Set(
    model.spans
      .filter((span) => span.start <= max && span.end >= min)
      .map((span) => span.index)
  );
}
