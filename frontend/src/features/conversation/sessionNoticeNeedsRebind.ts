import type { ConversationSessionNotice } from 'shared/types';

/** Mirrors `AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID` in conversations projection. */
export const AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID =
  'notice:agent-binding-load-failed';
/** Mirrors `AGENT_BINDING_REBIND_NOTICE_ROW_ID` in conversations projection. */
export const AGENT_BINDING_REBIND_NOTICE_ROW_ID =
  'notice:agent-session-rebound';
/** Mirrors `AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID` in conversations projection. */
export const AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID =
  'notice:agent-connection-recovering';
/** Mirrors `AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID` in conversations projection. */
export const AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID =
  'notice:agent-session-connect-error';

/**
 * Rebind is only for notices that mean the Agent session cannot continue.
 * Product banners, info notices, and warnings that do not block the session
 * must not offer it.
 */
export function sessionNoticeNeedsRebind(
  notice: ConversationSessionNotice,
  rowId?: string
): boolean {
  if (notice.announcement_id?.trim()) return false;
  if (notice.severity === 'info') return false;
  if (rowId === AGENT_BINDING_REBIND_NOTICE_ROW_ID) return false;
  if (rowId === AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID) return false;
  if (rowId === AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID) return false;
  if (rowId === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID) return true;
  return notice.severity === 'error';
}
