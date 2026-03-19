import { useQueries, useQuery } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
  const pendingSessionIdRef = useRef<string | null>(null);
  const previousWorkspaceIdRef = useRef<string | undefined>(workspaceId);

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
      enabled: enabled && !!workspaceId && !!session.id,
    })),
  });

  const sessions: WorkspaceSessionSummary[] = useMemo(
    () =>
      sessionSummaries.map((session, index) => {
        const queueStatus = queueStatusQueries[index]?.data ?? null;
        const displayName = session.first_prompt?.trim()
          ? session.first_prompt.trim()
          : `会话${sessionSummaries.length - index}`;
        const statusLabel = session.is_running
          ? '执行中'
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

  useEffect(() => {
    const workspaceChanged = previousWorkspaceIdRef.current !== workspaceId;
    previousWorkspaceIdRef.current = workspaceId;

    if (workspaceChanged) {
      pendingSessionIdRef.current = null;
    }

    if (sessions.length > 0) {
      setSelection((prev) => {
        if (prev?.mode === 'new') return prev;
        if (
          prev?.mode === 'existing' &&
          pendingSessionIdRef.current === prev.sessionId &&
          !sessions.some((session) => session.id === prev.sessionId)
        ) {
          return prev;
        }
        if (
          prev?.mode === 'existing' &&
          sessions.some((session) => session.id === prev.sessionId)
        ) {
          if (pendingSessionIdRef.current === prev.sessionId) {
            pendingSessionIdRef.current = null;
          }
          return prev;
        }
        if (
          initialSessionId &&
          !sessions.some((session) => session.id === initialSessionId)
        ) {
          return { mode: 'existing', sessionId: initialSessionId };
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
    pendingSessionIdRef.current = sessionId;
    setSelection({ mode: 'existing', sessionId });
  }, []);

  const selectLatestSession = useCallback(() => {
    if (sessions.length > 0) {
      pendingSessionIdRef.current = null;
      setSelection({ mode: 'existing', sessionId: sessions[0].id });
    }
  }, [sessions]);

  const startNewSession = useCallback(() => {
    pendingSessionIdRef.current = null;
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
