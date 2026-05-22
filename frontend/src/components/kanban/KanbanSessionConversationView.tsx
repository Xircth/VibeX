import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { Session, Workspace } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import VirtualizedList, {
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import { TaskFollowUpSection } from '@/components/tasks/TaskFollowUpSection';
import { EntriesProvider } from '@/contexts/EntriesContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { RetryUiProvider } from '@/contexts/RetryUiContext';
import { useRightPanelSessionCreation } from '@/contexts/RightPanelSessionCreationContext';
import { RightPanelNewSessionPrompt } from '@/components/layout/RightPanelNewSessionPrompt';
import {
  resolveActiveSession,
  useWorkspaceSessions,
} from '@/hooks/useWorkspaceSessions';
import { attemptsApi, sessionsApi } from '@/lib/api';
import { buildSessionConversationKey } from '@/lib/conversationKeys';

type SessionRecord = Session & {
  task_id?: string | null;
};

interface KanbanSessionConversationViewProps {
  workspaceId: string;
  sessionId?: string;
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
  const [isAtConversationBottom, setIsAtConversationBottom] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const rightPanelSessionCreation = useRightPanelSessionCreation();
  const sessionState = useWorkspaceSessions(attempt.id, {
    initialSessionId: attempt.session?.id,
    enabled: interactive,
    autoSelectFirstSession: interactive,
  });

  useEffect(() => {
    if (!interactive) return;
    if (searchParams.get('newSession') !== '1') return;

    if (rightPanelSessionCreation) {
      rightPanelSessionCreation.openCreateSessionOverlay();
    } else {
      sessionState.startNewSession();
    }
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('newSession');
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    interactive,
    rightPanelSessionCreation,
    searchParams,
    sessionState,
    setSearchParams,
  ]);

  const activeSession = interactive
    ? resolveActiveSession(attempt.session, sessionState)
    : attempt.session;

  const activeAttempt = useMemo(
    () => createWorkspaceWithSession(attempt, activeSession),
    [activeSession, attempt]
  );
  const shouldShowNewSessionPrompt =
    interactive &&
    !activeSession &&
    sessionState.sessions.length === 0 &&
    !sessionState.isNewSessionMode;

  const conversationKey = buildSessionConversationKey(
    attempt.id,
    activeSession?.id ?? attempt.session?.id
  );

  return (
    <EntriesProvider runtimeKey={conversationKey}>
      <ExecutionProcessesProvider
        attemptId={attempt.id}
        sessionId={activeSession?.id ?? attempt.session?.id}
      >
        <RetryUiProvider attemptId={attempt.id}>
          <div className="flex h-full min-h-0 flex-col">
            {shouldShowNewSessionPrompt ? (
              <RightPanelNewSessionPrompt
                className="flex-1"
                onCreateSession={() => {
                  if (rightPanelSessionCreation) {
                    rightPanelSessionCreation.openCreateSessionOverlay();
                    return;
                  }

                  sessionState.startNewSession();
                }}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <VirtualizedList
                  ref={logsRef}
                  attempt={activeAttempt}
                  task={null}
                  onAtBottomChange={setIsAtConversationBottom}
                />
              </div>
            )}
            {interactive &&
            !shouldShowNewSessionPrompt &&
            !isAtConversationBottom ? (
              <div className="pointer-events-none relative z-20 h-0">
                <button
                  type="button"
                  className="pointer-events-auto absolute left-1/2 top-0 inline-flex h-9 w-9 -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center justify-center rounded-full border border-border/70 bg-background/65 text-foreground/80 shadow-lg shadow-black/10 backdrop-blur-md transition hover:bg-background/85 hover:text-foreground"
                  aria-label="回到消息底部"
                  title="回到消息底部"
                  onClick={() => logsRef.current?.scrollToBottom()}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            ) : null}
            {interactive && !shouldShowNewSessionPrompt ? (
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
  className,
}: KanbanSessionConversationViewProps) {
  const { data: workspace, isLoading: isWorkspaceLoading } =
    useQuery<Workspace>({
      queryKey: ['taskAttempt', workspaceId],
      queryFn: () => attemptsApi.get(workspaceId),
      enabled: !!workspaceId,
      placeholderData: (previousData) =>
        previousData?.id === workspaceId ? previousData : undefined,
    });
  const {
    data: session,
    isError: isSessionError,
    isFetching: isSessionFetching,
  } = useQuery<SessionRecord>({
    queryKey: ['session', sessionId],
    queryFn: () => sessionsApi.getById(sessionId!) as Promise<SessionRecord>,
    enabled: !!sessionId,
    placeholderData: (previousData) =>
      previousData?.id === sessionId ? previousData : undefined,
  });

  const isBootstrappingWorkspace = !workspace && isWorkspaceLoading;
  const isBootstrappingSession =
    !!sessionId && !session && isSessionFetching && !isSessionError;

  if (isBootstrappingWorkspace || isBootstrappingSession || !workspace) {
    return (
      <div className={`relative ${className ?? ''}`}>
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>正在加载会话...</span>
        </div>
      </div>
    );
  }

  const resolvedSession = session ?? undefined;
  const taskId = resolvedSession?.task_id ?? workspace.task_id;
  const canInteractWithoutResolvedSession = interactive && !sessionId;
  const requestedSessionMissing = !!sessionId && isSessionError;
  const shouldRenderInteractiveShell =
    interactive &&
    (canInteractWithoutResolvedSession ||
      !!resolvedSession ||
      requestedSessionMissing);

  return (
    <div className={`relative ${className ?? ''}`}>
      <KanbanSessionConversationContent
        attempt={createWorkspaceWithSession(workspace, resolvedSession)}
        taskId={taskId}
        interactive={shouldRenderInteractiveShell}
        showSessionSelector={showSessionSelector}
        onSessionCreated={onSessionCreated}
        onSessionSelected={onSessionSelected}
      />
    </div>
  );
}
