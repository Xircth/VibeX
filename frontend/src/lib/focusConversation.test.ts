import { describe, expect, it } from 'vitest';
import {
  SESSION_PANEL_ID,
  focusEventMatchesWindow,
  focusWorkspaceConversation,
} from './focusConversation';

describe('focusWorkspaceConversation', () => {
  it('reuses the same session panel on a second call', () => {
    const first = focusWorkspaceConversation({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-b',
    });
    const second = focusWorkspaceConversation({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-c',
      existingPanelId: first.panelId,
    });

    expect(first.panelId).toBe(SESSION_PANEL_ID);
    expect(second.panelId).toBe(first.panelId);
    expect(second.panelId).toBe('ai-chat');
    expect(second.path).toBe(
      '/local-projects/project-1/workspaces/workspace-1/sessions/conversation-c'
    );
  });
});

describe('focusEventMatchesWindow', () => {
  const payload = {
    project_id: 'project-1',
    workspace_id: 'workspace-1',
    conversation_id: 'conversation-b',
    window_label: 'main',
  };

  it('accepts only the window named on the event', () => {
    expect(focusEventMatchesWindow(payload, 'main')).toBe(true);
    expect(focusEventMatchesWindow({ windowLabel: 'main' }, 'main')).toBe(
      true
    );
    expect(focusEventMatchesWindow(payload, 'settings')).toBe(false);
    expect(focusEventMatchesWindow({ project_id: 'project-1' }, 'main')).toBe(
      false
    );
    expect(focusEventMatchesWindow(payload, '')).toBe(false);
  });
});
