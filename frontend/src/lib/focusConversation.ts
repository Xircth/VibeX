import { paths } from '@/lib/paths';

/** The one session panel in a window. ADR-0042: do not open a second copy. */
export const SESSION_PANEL_ID = 'ai-chat';

export type FocusConversationTarget = {
  projectId: string;
  workspaceId: string;
  conversationId: string;
  existingPanelId?: string | null;
};

export function focusWorkspaceConversation(target: FocusConversationTarget): {
  panelId: string;
  path: string;
} {
  const panelId = target.existingPanelId?.trim() || SESSION_PANEL_ID;
  return {
    panelId,
    path: paths.projectSession(
      target.projectId,
      target.workspaceId,
      target.conversationId
    ),
  };
}

export type FocusConversationPayload = {
  projectId: string;
  workspaceId: string;
  conversationId: string;
  panelId: string;
};

export function parseFocusConversationPayload(
  payload: unknown
): FocusConversationPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const projectId = stringField(record, 'projectId', 'project_id');
  const workspaceId = stringField(record, 'workspaceId', 'workspace_id');
  const conversationId = stringField(
    record,
    'conversationId',
    'conversation_id'
  );
  if (!projectId || !workspaceId || !conversationId) return null;
  return {
    projectId,
    workspaceId,
    conversationId,
    panelId: stringField(record, 'panelId', 'panel_id') || SESSION_PANEL_ID,
  };
}

/** Host events are broadcast to every window. Only the named window navigates. */
export function focusEventMatchesWindow(
  payload: unknown,
  windowLabel: string
): boolean {
  if (!payload || typeof payload !== 'object' || !windowLabel.trim()) {
    return false;
  }
  const label = stringField(
    payload as Record<string, unknown>,
    'windowLabel',
    'window_label'
  );
  return label !== '' && label === windowLabel;
}

function stringField(
  record: Record<string, unknown>,
  camel: string,
  snake: string
): string {
  const value = record[camel] ?? record[snake];
  return typeof value === 'string' ? value.trim() : '';
}
