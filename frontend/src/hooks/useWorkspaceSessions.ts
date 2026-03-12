import { useQueries, useQuery } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { queueApi, sessionsApi } from '@/lib/api';
import type { QueueStatus, Session } from 'shared/types';
import type { SessionSummary as SessionSummaryRecord } from '@/lib/api';

interface UseWorkspaceSessionsOptions {
  enabled?: boolean;
  initialSessionId?: string;
}

/** Discriminated union for session selection state */
export type SessionSelection =
  | { mode: 'existing'; sessionId: string }
  | { mode: 'new' };

export interface WorkspaceSessionSummary extends Session {
  firstPrompt: string | null;
  isRunning: boolean;
  queueStatus: QueueStatus | null;
  displayName: string;
  statusLabel: string;
}

export interface UseWorkspaceSessionsResult {
  sessions: WorkspaceSessionSummary[];
  selectedSession: WorkspaceSessionSummary | undefined;
  selectedSessionId: string | undefined;
  selectSession: (sessionId: string) => void;
  selectLatestSession: () => void;
  isLoading: boolean;
  /** Whether user is creating a new session */
  isNewSessionMode: boolean;
  /** Enter new session mode */
  startNewSession: () => void;
}

/**
 * Hook for managing sessions within a workspace.
 * Fetches all sessions for a workspace and provides session switching capability.
 * Sessions are ordered by most recently used (latest non-dev server execution first).
 */
export function useWorkspaceSessions(
  workspaceId: string | undefined,
  options: UseWorkspaceSessionsOptions = {}
): UseWorkspaceSessionsResult {
  const { enabled = true, initialSessionId } = options;
  const [selection, setSelection] = useState<SessionSelection | undefined>(
    undefined
  );

  const { data: sessionSummaries = [], isLoading } = useQuery<
    SessionSummaryRecord[]
  >({
    queryKey: ['workspaceSessions', workspaceId, 'summaries'],
    queryFn: () => sessionsApi.getSummariesByWorkspace(workspaceId!),
    enabled: enabled && !!workspaceId,
  });

  const queueStatusQueries = useQueries({
    queries: sessionSummaries.map((session) => ({
      queryKey: ['sessionQueueStatus', session.id],
      queryFn: () => queueApi.getStatus(session.id),
      enabled: enabled && !!workspaceId,
    })),
  });

  const sessions: WorkspaceSessionSummary[] = useMemo(
    () =>
      sessionSummaries.map((session, index) => {
        const queueStatus = queueStatusQueries[index]?.data ?? null;
        const displayName = session.first_prompt?.trim()
          ? session.first_prompt.trim()
          : `session${sessionSummaries.length - index}`;
        const statusLabel = session.is_running
          ? '运行中'
          : queueStatus?.status === 'queued'
            ? '排队中'
            : '空闲';

        return {
          id: session.id,
          workspace_id: session.workspace_id,
          executor: session.executor,
          created_at: session.created_at,
          updated_at: session.updated_at,
          firstPrompt: session.first_prompt,
          isRunning: session.is_running,
          queueStatus,
          displayName,
          statusLabel,
        };
      }),
    [queueStatusQueries, sessionSummaries]
  );

  // Combined effect: handle workspace changes and auto-select sessions
  // This replaces two separate effects that had a race condition where the reset
  // effect would fire after auto-select when sessions were cached, undoing the selection.
  useEffect(() => {
    if (sessions.length > 0) {
      // Sessions are ordered by most recently used, so first is the most recently used
      // Always select first session when sessions are available for this workspace
      // Only auto-select if not in new session mode
      setSelection((prev) => {
        if (prev?.mode === 'new') return prev;
        if (
          prev?.mode === 'existing' &&
          sessions.some((session) => session.id === prev.sessionId)
        ) {
          return prev;
        }
        if (
          initialSessionId &&
          sessions.some((session) => session.id === initialSessionId)
        ) {
          return { mode: 'existing', sessionId: initialSessionId };
        }
        return { mode: 'existing', sessionId: sessions[0].id };
      });
    } else {
      setSelection(undefined);
    }
  }, [workspaceId, sessions, initialSessionId]);

  const isNewSessionMode = selection?.mode === 'new' || sessions.length === 0;
  const selectedSessionId =
    selection?.mode === 'existing' ? selection.sessionId : undefined;

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    setSelection({ mode: 'existing', sessionId });
  }, []);

  const selectLatestSession = useCallback(() => {
    if (sessions.length > 0) {
      setSelection({ mode: 'existing', sessionId: sessions[0].id });
    }
  }, [sessions]);

  const startNewSession = useCallback(() => {
    setSelection({ mode: 'new' });
  }, []);

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading,
    isNewSessionMode,
    startNewSession,
  };
}
