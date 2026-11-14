import type {
  ConversationConnectionStatus,
  ConversationRequestStatus,
  TimelineRow,
  RequestPhase,
} from 'shared/types';

export function conversationRuntimeStatus(rows: readonly TimelineRow[]) {
  let connection: ConversationConnectionStatus | null = null;
  let request: ConversationRequestStatus | null = null;
  for (const row of rows) {
    if (row.row.kind !== 'session_notice') continue;
    if (row.row.notice.connection_status)
      connection = row.row.notice.connection_status;
    if (row.row.notice.request_status) request = row.row.notice.request_status;
  }
  return { connection, request };
}

export function isRequestTerminal(phase: RequestPhase): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(phase);
}

export function requestStatusKey(input: {
  request: ConversationRequestStatus | null;
  connection: ConversationConnectionStatus | null;
  hasInteraction?: boolean;
  hasRunningTool?: boolean;
  queued?: boolean;
  currentTurnId?: string;
}): RequestPhase {
  if (input.currentTurnId && input.request?.turn_id !== input.currentTurnId)
    return 'submitting';
  const phase = input.request?.activity.phase;
  if (phase === 'cancelling') return phase;
  if (phase && isRequestTerminal(phase)) return phase;
  if (input.hasInteraction) return 'waiting_user';
  if (input.hasRunningTool) return 'executing_tool';
  if (input.queued || phase === 'submitting') return 'submitting';
  if (
    input.connection &&
    !input.connection.bound &&
    (phase === 'responding' || phase === 'thinking')
  )
    return 'waiting_agent';
  return phase ?? 'waiting_agent';
}

export function waitingAdvisory(
  phase: RequestPhase,
  since: string,
  now: number
): number | null {
  if (
    ![
      'submitting',
      'waiting_agent',
      'waiting_model',
      'thinking',
      'responding',
    ].includes(phase)
  )
    return null;
  const timestamp = Date.parse(since);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  return seconds >= 30 ? seconds : null;
}
