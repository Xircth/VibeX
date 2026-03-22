import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Session, TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import VirtualizedList, {
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import { TaskFollowUpSection } from '@/components/tasks/TaskFollowUpSection';
import { EntriesProvider } from '@/contexts/EntriesContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { RetryUiProvider } from '@/contexts/RetryUiContext';
import { useProject } from '@/contexts/ProjectContext';
import { useWorkspaceSessions } from '@/hooks/useWorkspaceSessions';
import { resolveActiveSession } from '@/hooks/useWorkspaceSessions';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { sessionsApi } from '@/lib/api';

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
  className?: string;
}

function KanbanSessionConversationContent({
  attempt,
  task,
  interactive,
  showSessionSelector,
  onSessionCreated,
  onSessionSelected,
}: {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus;
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
  const sessionState = useWorkspaceSessions(attempt.id, {
    initialSessionId: attempt.session?.id,
    enabled: interactive,
  });

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
            <div className="flex-1 min-h-0 overflow-hidden">
              <VirtualizedList
                ref={logsRef}
                attempt={activeAttempt}
                task={task}
              />
            </div>
            {interactive ? (
              <TaskFollowUpSection
                task={task}
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
  className,
}: KanbanSessionConversationViewProps) {
  const { projectId } = useProject();
  const { tasksById } = useProjectTasks(projectId ?? '');
  const { data: workspace, isLoading: isWorkspaceLoading } =
    useTaskAttempt(workspaceId);
  const { data: session, isLoading: isSessionLoading } = useQuery<SessionRecord>({
    queryKey: ['session', sessionId],
    queryFn: () => sessionsApi.getById(sessionId) as Promise<SessionRecord>,
    enabled: !!sessionId,
  });

  if (isWorkspaceLoading || isSessionLoading) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        正在加载会话...
      </div>
    );
  }

  if (!workspace || !session) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        会话不可用。
      </div>
    );
  }

  const taskId = session.task_id ?? workspace.task_id;
  const task = (taskId ? tasksById[taskId] : null) ?? null;

  if (!task) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        任务不可用。
      </div>
    );
  }

  return (
    <div className={className}>
      <KanbanSessionConversationContent
        key={`${workspace.id}:${session.id}:${interactive ? 'interactive' : 'readonly'}`}
        attempt={createWorkspaceWithSession(workspace, session)}
        task={task}
        interactive={interactive}
        showSessionSelector={showSessionSelector}
        onSessionCreated={onSessionCreated}
        onSessionSelected={onSessionSelected}
      />
    </div>
  );
}
