import type { TimelineRow } from 'shared/types';
import type { ConversationStoreEntry } from './turnLifecycle';

const EMPTY_TIMELINE_ROWS: TimelineRow[] = [];
const sideRowsByEntryRows = new WeakMap<TimelineRow[], TimelineRow[]>();
const lastSideRowsByConversation = new Map<string, TimelineRow[]>();

export function sideRowsForEntry(
  entry: ConversationStoreEntry | null
): TimelineRow[] {
  if (!entry || entry.rows.length === 0) return EMPTY_TIMELINE_ROWS;
  const cached = sideRowsByEntryRows.get(entry.rows);
  if (cached) return cached;

  const filtered = entry.rows.filter((row) => row.row.kind !== 'message_turn');
  if (filtered.length === 0) {
    sideRowsByEntryRows.set(entry.rows, EMPTY_TIMELINE_ROWS);
    return EMPTY_TIMELINE_ROWS;
  }

  const convId = entry.conversationId;
  if (convId) {
    const prev = lastSideRowsByConversation.get(convId);
    if (
      prev &&
      prev.length === filtered.length &&
      prev.every((row, index) => row === filtered[index])
    ) {
      sideRowsByEntryRows.set(entry.rows, prev);
      return prev;
    }
    if (
      lastSideRowsByConversation.size >= 32 &&
      !lastSideRowsByConversation.has(convId)
    ) {
      const oldest = lastSideRowsByConversation.keys().next().value;
      if (oldest !== undefined) lastSideRowsByConversation.delete(oldest);
    }
    lastSideRowsByConversation.set(convId, filtered);
  }
  sideRowsByEntryRows.set(entry.rows, filtered);
  return filtered;
}

/** Persona and other standing host notes stay on the timeline. */
export function isDurableHostNote(row: TimelineRow): boolean {
  if (row.row_id.startsWith('host-note:')) return true;
  if (row.row.kind !== 'session_notice') return false;
  const id = row.row.notice.announcement_id ?? '';
  return id.startsWith('host-note:');
}

/** The standing persona card (`host-note:persona` / 人设). */
export function isPersonaHostNote(row: TimelineRow): boolean {
  if (row.row_id === 'host-note:persona') return true;
  if (row.row.kind !== 'session_notice') return false;
  return (row.row.notice.announcement_id ?? '') === 'host-note:persona';
}

/** Standing inline cross-Agent handoff divider (`host-note:agent-handoff:after:{turn_id}`). */
export const AGENT_HANDOFF_HOST_NOTE_PREFIX = 'host-note:agent-handoff:';

export type ParsedAgentHandoffNotice = {
  fromAgent: string;
  toAgent: string;
  fromModel: string | null;
  toModel: string | null;
  handoffTokens: number | null;
  continuationPolicy: 'portable' | 'fresh';
};

export function isAgentHandoffHostNote(row: TimelineRow): boolean {
  if (row.row_id.startsWith(AGENT_HANDOFF_HOST_NOTE_PREFIX)) return true;
  if (row.row.kind !== 'session_notice') return false;
  return (row.row.notice.announcement_id ?? '').startsWith(
    AGENT_HANDOFF_HOST_NOTE_PREFIX
  );
}

export function parseAgentHandoffNotice(
  row: TimelineRow
): ParsedAgentHandoffNotice | null {
  if (!isAgentHandoffHostNote(row) || row.row.kind !== 'session_notice') {
    return null;
  }
  const raw = row.row.notice.message?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fromAgent =
      typeof parsed.fromAgent === 'string' ? parsed.fromAgent.trim() : '';
    const toAgent =
      typeof parsed.toAgent === 'string' ? parsed.toAgent.trim() : '';
    const norm = (id: string) => id.toLowerCase().replace(/[-_\s]/g, '');
    if (!fromAgent || !toAgent || norm(fromAgent) === norm(toAgent)) {
      return null;
    }
    const fromModel =
      typeof parsed.fromModel === 'string' && parsed.fromModel.trim().length > 0
        ? parsed.fromModel.trim()
        : null;
    const toModel =
      typeof parsed.toModel === 'string' && parsed.toModel.trim().length > 0
        ? parsed.toModel.trim()
        : null;
    const rawTokens =
      parsed.handoffTokens ??
      parsed.handoff_tokens ??
      parsed.totalTokens ??
      parsed.total_tokens;
    const handoffTokens =
      typeof rawTokens === 'number' &&
      Number.isFinite(rawTokens) &&
      rawTokens > 0
        ? Math.round(rawTokens)
        : null;
    const continuationPolicy =
      parsed.continuationPolicy === 'fresh' ? 'fresh' : 'portable';
    return {
      fromAgent,
      toAgent,
      fromModel,
      toModel,
      handoffTokens,
      continuationPolicy,
    };
  } catch {
    return null;
  }
}

export function shouldShowDurableHostNote(
  row: TimelineRow,
  options: { hidePersonaHostNotes?: boolean } = {}
): boolean {
  if (!isDurableHostNote(row)) return false;
  if (options.hidePersonaHostNotes && isPersonaHostNote(row)) return false;
  return true;
}

const INLINE_SIDE_ROW_KINDS = new Set([
  'terminal_summary',
  'delegation',
  'artifact_revision',
  'feedback_request',
  'question_request',
  'session_notice',
]);

export function defaultInlineSideRow(row: TimelineRow): boolean {
  return INLINE_SIDE_ROW_KINDS.has(row.row.kind);
}
