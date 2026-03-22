import type { TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import VirtualizedList, {
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import { TaskFollowUpSection } from '@/components/tasks/TaskFollowUpSection';
import { EntriesProvider } from '@/contexts/EntriesContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { RetryUiProvider } from '@/contexts/RetryUiContext';
import { useCallback, useRef, type ReactNode } from 'react';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorkspaceSessions } from '@/hooks/useWorkspaceSessions';
import { resolveActiveSession } from '@/hooks/useWorkspaceSessions';

interface TaskAttemptPanelProps {
  attempt: WorkspaceWithSession | undefined;
  task: TaskWithAttemptStatus | null;
  children: (sections: { logs: ReactNode; followUp: ReactNode }) => ReactNode;
}

const TaskAttemptPanel = ({
  attempt,
  task,
  children,
}: TaskAttemptPanelProps) => {
  const kanbanSessionContext = useOptionalKanbanSessionContext();
  const sessionState = useWorkspaceSessions(attempt?.id, {
    initialSessionId: attempt?.session?.id,
  });
  const logsRef = useRef<VirtualizedListRef | null>(null);
  const syncRightPanelSession = useCallback(
    (session: { sessionId: string; workspaceId: string }) => {
      kanbanSessionContext?.replaceRightSession(session);
    },
    [kanbanSessionContext]
  );

  if (!attempt) {
    return <div className="p-6 text-muted-foreground">Loading attempt...</div>;
  }

  if (!task) {
    return <div className="p-6 text-muted-foreground">Loading task...</div>;
  }
  const activeSession = resolveActiveSession(attempt.session, sessionState);
  const activeAttempt = createWorkspaceWithSession(attempt, activeSession);
  const conversationKey = `${attempt.id}:${activeSession?.id ?? 'new'}`;

  return (
    <EntriesProvider key={conversationKey} cacheKey={conversationKey}>
      <ExecutionProcessesProvider
        key={conversationKey}
        attemptId={attempt.id}
        sessionId={activeSession?.id}
      >
        <RetryUiProvider attemptId={attempt.id}>
          {children({
            logs: (
              <VirtualizedList
                ref={logsRef}
                attempt={activeAttempt}
                task={task}
              />
            ),
            followUp: (
              <TaskFollowUpSection
                task={task}
                session={activeSession}
                workspaceId={attempt.id}
                sessionState={sessionState}
                onSessionCreated={syncRightPanelSession}
                onSessionSelected={syncRightPanelSession}
                onJumpToPreviousUserMessage={() =>
                  logsRef.current?.scrollToPreviousUserMessage()
                }
              />
            ),
          })}
        </RetryUiProvider>
      </ExecutionProcessesProvider>
    </EntriesProvider>
  );
};

export default TaskAttemptPanel;
