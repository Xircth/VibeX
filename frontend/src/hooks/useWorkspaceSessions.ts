import { useQuery } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { sessionsApi } from '@/lib/api';
import type {
  SessionStatus,
  SessionSummary as SessionSummaryRecord,
} from '@/lib/api';
import type { Session, SessionContinuityMode } from 'shared/types';
import { getContinuityActionCopy } from '@/utils/sessionContinuity';
import type { QueueStatus } from '@/components/tasks/follow-up/sessionComposerQueue';

interface UseWorkspaceSessionsOptions {
  enabled?: boolean;
  initialSessionId?: string;
  autoSelectFirstSession?: boolean;
}

export type SessionSelection =
  | { mode: 'existing'; sessionId: string }
  | { mode: 'new' };

export interface WorkspaceSessionSummary extends Session {
  taskId: string | null;
  name: string | null;
  status: SessionStatus;
  firstPrompt: string | null;
  isRunning: boolean;
  queueStatus: QueueStatus | null;
  displayName: string;
  workspaceName: string | null;
  workspaceBranch: string;
  statusLabel: string;
  continuityMode: SessionContinuityMode;
  continuityLabel: string;
}

function getContinuityLabel(mode: SessionContinuityMode) {
  return getContinuityActionCopy(mode).shortLabel;
}

export interface UseWorkspaceSessionsResult {
  sessions: WorkspaceSessionSummary[];
  selectedSession: WorkspaceSessionSummary | undefined;
  selectedSessionId: string | undefined;
  selectSession: (sessionId: string) => void;
  selectLatestSession: () => void;
  isLoading: boolean;
  isNewSessionMode: boolean;
  isPendingNewSessionMode: boolean;
  requestNewSession: () => void;
  confirmNewSession: () => void;
  cancelNewSession: () => void;
  startNewSession: () => void;
}

export type ActiveSessionSelectionState = Pick<
  UseWorkspaceSessionsResult,
  'selectedSession' | 'selectedSessionId' | 'isNewSessionMode'
>;

export function resolveActiveSession(
  sessionFromAttempt: Session | undefined,
  sessionState: ActiveSessionSelectionState
): Session | undefined {
  if (sessionState.isNewSessionMode) {
    return undefined;
  }

  if (!sessionState.selectedSessionId) {
    return sessionFromAttempt;
  }

  if (sessionState.selectedSession?.id === sessionState.selectedSessionId) {
    return sessionState.selectedSession;
  }

  if (sessionFromAttempt?.id === sessionState.selectedSessionId) {
    return sessionFromAttempt;
  }

  return sessionFromAttempt;
}

function getSessionStatusLabel(
  status: SessionStatus,
  isRunning: boolean,
  queueStatus: QueueStatus | null,
  t: TFunction<['app', 'common']>
) {
  if (isRunning) return t('workspaceSessions.statusRunning');
  if (queueStatus?.status === 'queued')
    return t('workspaceSessions.statusQueued');

  switch (status) {
    case 'todo':
      return t('workspaceSessions.statusTodo');
    case 'inprogress':
      return t('workspaceSessions.statusInProgress');
    case 'inreview':
      return t('workspaceSessions.statusInReview');
    case 'done':
      return t('workspaceSessions.statusDone');
    default:
      return t('workspaceSessions.statusIdle');
  }
}

export function useWorkspaceSessions(
  workspaceId: string | undefined,
  options: UseWorkspaceSessionsOptions = {}
): UseWorkspaceSessionsResult {
  const { t } = useTranslation(['app', 'common']);
  const {
    enabled = true,
    initialSessionId,
    autoSelectFirstSession = true,
  } = options;
  const [selection, setSelection] = useState<SessionSelection | undefined>(
    undefined
  );
  const [isPendingNewSessionMode, setIsPendingNewSessionMode] = useState(false);
  const pendingSessionIdRef = useRef<string | null>(null);
  const previousWorkspaceIdRef = useRef<string | undefined>(workspaceId);
  const previousInitialSessionIdRef = useRef<string | undefined>(
    initialSessionId
  );

  const { data: sessionSummaries = [], isLoading } = useQuery<
    SessionSummaryRecord[]
  >({
    queryKey: ['workspaceSessions', workspaceId, 'summaries'],
    queryFn: () => sessionsApi.getSummariesByWorkspace(workspaceId!),
    enabled: enabled && !!workspaceId,
  });

  const sessions: WorkspaceSessionSummary[] = useMemo(
    () =>
      sessionSummaries.map((session) => {
        return {
          id: session.id,
          workspace_id: session.workspace_id,
          taskId: session.task_id,
          name: session.name,
          status: session.status,
          executor: session.executor,
          created_at: session.created_at,
          updated_at: session.updated_at,
          firstPrompt: session.first_prompt,
          isRunning: session.is_running,
          queueStatus: null,
          displayName: session.display_name,
          workspaceName: session.workspace_name,
          workspaceBranch: session.workspace_branch,
          statusLabel: getSessionStatusLabel(
            session.status,
            session.is_running,
            null,
            t
          ),
          continuityMode: session.continuity_mode,
          continuityLabel: getContinuityLabel(session.continuity_mode),
        } as WorkspaceSessionSummary;
      }),
    [sessionSummaries, t]
  );

  useEffect(() => {
    const initialSessionChanged =
      previousInitialSessionIdRef.current !== initialSessionId;
    previousInitialSessionIdRef.current = initialSessionId;

    if (!initialSessionChanged || !initialSessionId) {
      return;
    }

    pendingSessionIdRef.current = initialSessionId;
    setIsPendingNewSessionMode(false);
    setSelection({ mode: 'existing', sessionId: initialSessionId });
  }, [initialSessionId]);

  useEffect(() => {
    const workspaceChanged = previousWorkspaceIdRef.current !== workspaceId;
    previousWorkspaceIdRef.current = workspaceId;

    if (workspaceChanged) {
      pendingSessionIdRef.current = null;
      setIsPendingNewSessionMode(false);
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
        if (!autoSelectFirstSession) {
          return undefined;
        }
        return { mode: 'existing', sessionId: sessions[0].id };
      });
    } else {
      setSelection((prev) => (prev?.mode === 'new' ? prev : undefined));
    }
  }, [autoSelectFirstSession, workspaceId, sessions, initialSessionId]);

  const isNewSessionMode = selection?.mode === 'new';
  const selectedSessionId =
    selection?.mode === 'existing' ? selection.sessionId : undefined;

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    pendingSessionIdRef.current = sessionId;
    setIsPendingNewSessionMode(false);
    setSelection({ mode: 'existing', sessionId });
  }, []);

  const selectLatestSession = useCallback(() => {
    if (sessions.length > 0) {
      pendingSessionIdRef.current = null;
      setIsPendingNewSessionMode(false);
      setSelection({ mode: 'existing', sessionId: sessions[0].id });
    }
  }, [sessions]);

  const startNewSession = useCallback(() => {
    pendingSessionIdRef.current = null;
    setIsPendingNewSessionMode(false);
    setSelection({ mode: 'new' });
  }, []);

  const requestNewSession = useCallback(() => {
    if (sessions.length === 0) {
      pendingSessionIdRef.current = null;
      setIsPendingNewSessionMode(false);
      setSelection({ mode: 'new' });
      return;
    }

    setIsPendingNewSessionMode(true);
  }, [sessions.length]);

  const confirmNewSession = useCallback(() => {
    pendingSessionIdRef.current = null;
    setIsPendingNewSessionMode(false);
    setSelection({ mode: 'new' });
  }, []);

  const cancelNewSession = useCallback(() => {
    setIsPendingNewSessionMode(false);
  }, []);

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading,
    isNewSessionMode,
    isPendingNewSessionMode,
    requestNewSession,
    confirmNewSession,
    cancelNewSession,
    startNewSession,
  };
}
