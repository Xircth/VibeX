import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { Session, TaskWithAttemptStatus, Workspace } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import VirtualizedList, {
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import { TaskFollowUpSection } from '@/components/tasks/TaskFollowUpSection';
import { EntriesProvider } from '@/contexts/EntriesContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { RetryUiProvider } from '@/contexts/RetryUiContext';
import {
  resolveActiveSession,
  useWorkspaceSessions,
} from '@/hooks/useWorkspaceSessions';
import { attemptsApi, sessionsApi } from '@/lib/api';

type SessionRecord = Session & {
  task_id?: string | null;
};

interface KanbanSessionConversationViewProps {
  workspaceId: string;
  sessionId: string;
  interactive?: boolean;
  showSessionSelector?: boolean;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onSessionSelected?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  initialWorkspace?: Workspace | null;
  initialSession?: Session | null;
  initialTask?: TaskWithAttemptStatus | null;
  className?: string;
}

function createFallbackWorkspace(
  workspaceId: string,
  initialWorkspace?: Workspace | null
): Workspace {
  if (initialWorkspace) {
    return initialWorkspace;
  }

  const now = new Date(0).toISOString();

  return {
    id: workspaceId,
    project_id: '',
    task_id: '',
    parent_workspace_id: null,
    container_ref: null,
    branch: '',
    use_worktree: true,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: now,
    updated_at: now,
    archived: false,
    pinned: false,
    name: null,
  };
}

function createFallbackSession(
  sessionId: string,
  workspaceId: string,
  initialSession?: Session | null
): SessionRecord {
  if (initialSession) {
    return initialSession;
  }

  const now = new Date(0).toISOString();

  return {
    id: sessionId,
    workspace_id: workspaceId,
    task_id: null,
    name: null,
    initial_prompt: null,
    status: 'todo',
    executor: null,
    created_at: now,
    updated_at: now,
  };
}

function KanbanSessionConversationContent({
  attempt,
  taskId,
  interactive,
  showSessionSelector,
  onSessionCreated,
  onSessionSelected,
}: {
  attempt: WorkspaceWithSession;
  taskId: string | null;
  interactive: boolean;
  showSessionSelector: boolean;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onSessionSelected?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
}) {
  const logsRef = useRef<VirtualizedListRef | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionState = useWorkspaceSessions(attempt.id, {
    initialSessionId: attempt.session?.id,
    enabled: interactive,
  });

  useEffect(() => {
    if (!interactive) return;
    if (searchParams.get('newSession') !== '1') return;

    sessionState.startNewSession();
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('newSession');
    setSearchParams(nextSearchParams, { replace: true });
  }, [interactive, searchParams, sessionState, setSearchParams]);

  const activeSession = interactive
    ? resolveActiveSession(attempt.session, sessionState)
    : attempt.session;

  const activeAttempt = useMemo(
    () => createWorkspaceWithSession(attempt, activeSession),
    [activeSession, attempt]
  );

  const conversationKey = `${attempt.id}:${activeSession?.id ?? attempt.session?.id ?? 'unknown'}`;

  return (
    <EntriesProvider key={conversationKey} cacheKey={conversationKey}>
      <ExecutionProcessesProvider
        key={conversationKey}
        attemptId={attempt.id}
        sessionId={activeSession?.id ?? attempt.session?.id}
      >
        <RetryUiProvider attemptId={attempt.id}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <VirtualizedList
                ref={logsRef}
                attempt={activeAttempt}
                task={null}
              />
            </div>
            {interactive ? (
              <TaskFollowUpSection
                taskId={taskId}
                session={activeSession}
                workspaceId={attempt.id}
                sessionState={sessionState}
                showSessionSelector={showSessionSelector}
                onSessionCreated={onSessionCreated}
                onSessionSelected={onSessionSelected}
                onJumpToPreviousUserMessage={() =>
                  logsRef.current?.scrollToPreviousUserMessage()
                }
              />
            ) : null}
          </div>
        </RetryUiProvider>
      </ExecutionProcessesProvider>
    </EntriesProvider>
  );
}

export function KanbanSessionConversationView({
  workspaceId,
  sessionId,
  interactive = false,
  showSessionSelector = false,
  onSessionCreated,
  onSessionSelected,
  initialWorkspace,
  initialSession,
  initialTask,
  className,
}: KanbanSessionConversationViewProps) {
  const { data: workspace, isLoading: isWorkspaceLoading } =
    useQuery<Workspace>({
      queryKey: ['taskAttempt', workspaceId],
      queryFn: () => attemptsApi.get(workspaceId),
      enabled: !!workspaceId,
      placeholderData: (previousData) =>
        previousData?.id === workspaceId
          ? previousData
          : (initialWorkspace ?? undefined),
    });
  const { data: session, isFetching: isSessionFetching } =
    useQuery<SessionRecord>({
      queryKey: ['session', sessionId],
      queryFn: () => sessionsApi.getById(sessionId) as Promise<SessionRecord>,
      enabled: !!sessionId,
      placeholderData: (previousData) =>
        previousData?.id === sessionId
          ? previousData
          : (initialSession ?? undefined),
    });

  const resolvedWorkspace =
    workspace ?? createFallbackWorkspace(workspaceId, initialWorkspace);
  const resolvedSession =
    session ?? createFallbackSession(sessionId, workspaceId, initialSession);
  const taskId =
    resolvedSession.task_id ?? initialTask?.id ?? resolvedWorkspace.task_id;

  const isBootstrapping =
    (!workspace && isWorkspaceLoading && !initialWorkspace) ||
    (!session && isSessionFetching && !initialSession);

  return (
    <div className={`relative ${className ?? ''}`}>
      {isBootstrapping ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>正在加载会话...</span>
        </div>
      ) : null}
      <KanbanSessionConversationContent
        key={`${resolvedWorkspace.id}:${resolvedSession.id}:${interactive ? 'interactive' : 'readonly'}`}
        attempt={createWorkspaceWithSession(resolvedWorkspace, resolvedSession)}
        taskId={taskId}
        interactive={interactive && !!session}
        showSessionSelector={showSessionSelector}
        onSessionCreated={onSessionCreated}
        onSessionSelected={onSessionSelected}
      />
    </div>
  );
}
