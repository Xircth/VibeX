import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import {
  sessionsApi,
  type SessionSummary as SessionSummaryRecord,
} from '@/lib/api';
import {
  reconcileWorkspaceSessionSelection,
  useWorkspaceSessions,
} from './useWorkspaceSessions';

describe('reconcileWorkspaceSessionSelection', () => {
  it('keeps a pending session over an older in-list selection', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-a' },
      sessionIds: ['session-a', 'session-b'],
      initialSessionId: 'session-b',
      pendingSessionId: 'session-b',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
    expect(next.pendingSessionId).toBeNull();
  });

  it('does not drop a just-created session while the list is still empty', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-new' },
      sessionIds: [],
      initialSessionId: 'session-new',
      pendingSessionId: 'session-new',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-new',
    });
    expect(next.pendingSessionId).toBe('session-new');
  });

  it('keeps a local composer selection when the parent id has not echoed yet', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-b' },
      sessionIds: ['session-a', 'session-b'],
      initialSessionId: 'session-a',
      pendingSessionId: null,
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
  });

  it('preserves pending across a workspace change when it matches the new initial id', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-a' },
      sessionIds: ['session-b'],
      initialSessionId: 'session-b',
      pendingSessionId: 'session-b',
      autoSelectFirstSession: true,
      workspaceChanged: true,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
  });

  it('exits new-session mode when the parent jumps to a created or list-selected session', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'new' },
      sessionIds: ['session-a', 'session-new'],
      initialSessionId: 'session-new',
      pendingSessionId: 'session-new',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-new',
    });
    expect(next.pendingSessionId).toBeNull();
  });

  it('reuses the existing selection reference when the resolved sessionId is unchanged to prevent render loops', () => {
    const prev = { mode: 'existing' as const, sessionId: 'session-pending' };
    const next = reconcileWorkspaceSessionSelection({
      prev,
      sessionIds: [],
      initialSessionId: 'session-pending',
      pendingSessionId: 'session-pending',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toBe(prev);
    expect(next.pendingSessionId).toBe('session-pending');
  });

  it('does not auto-select background Bot sessions excluded from autoSelectSessionIds', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: undefined,
      sessionIds: ['bot-master-session'],
      autoSelectSessionIds: [],
      initialSessionId: undefined,
      pendingSessionId: null,
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toBeUndefined();
    expect(next.pendingSessionId).toBeNull();
  });
});

describe('useWorkspaceSessions agent icon metadata', () => {
  it('exposes switched agent_id and model on WorkspaceSessionSummary instead of staying stuck on creation executor', async () => {
    const summary: SessionSummaryRecord = {
      id: 'session-switched',
      workspace_id: 'ws-1',
      task_id: null,
      name: 'Switched Session',
      status: 'todo',
      executor: 'CLAUDE_CODE',
      agent_id: 'codex',
      model: 'gpt-5',
      created_at: '2026-11-14T00:00:00Z',
      updated_at: '2026-11-14T00:01:00Z',
      first_prompt: null,
      is_running: false,
      display_name: 'Switched Session',
      workspace_name: 'main',
      workspace_branch: 'main',
      continuity_mode: 'new_session',
      pinned_at: null,
      collaboration: null,
    };
    const spy = vi
      .spyOn(sessionsApi, 'getSummariesByWorkspace')
      .mockResolvedValue([summary]);

    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useWorkspaceSessions('ws-1'), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      expect(sessionListAgentKey(result.current.sessions[0])).toBe('codex');
      expect(result.current.sessions[0].agent_id).toBe('codex');
      expect(result.current.sessions[0].model).toBe('gpt-5');
    } finally {
      spy.mockRestore();
    }
  });
});
