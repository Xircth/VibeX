import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
import { RightPanelNewSessionPrompt } from '@/components/layout/RightPanelNewSessionPrompt';
import {
  resolveActiveSession,
  useWorkspaceSessions,
  type UseWorkspaceSessionsResult,
} from '@/hooks/useWorkspaceSessions';
import { attemptsApi, sessionsApi } from '@/lib/api';
import { buildSessionConversationKey } from '@/lib/conversationKeys';
import { getKanbanSessionDetailQueryState } from './kanbanSessionConversationQuery';

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
  onCreateSessionRequested?: () => void;
  className?: string;
}

interface KanbanSessionConversationSurfaceProps
  extends KanbanSessionConversationViewProps {
  sessionState: UseWorkspaceSessionsResult;
}

type ConversationPlacementRecord = {
  key: string;
  container: HTMLDivElement;
  props: KanbanSessionConversationSurfaceProps;
  slots: Map<string, HTMLElement>;
  activeSlotId: string | null;
};

type ConversationPlacementContextValue = {
  mountSlot: (
    key: string,
    slotId: string,
    target: HTMLElement,
    props: KanbanSessionConversationSurfaceProps
  ) => () => void;
};

const ConversationPlacementContext =
  createContext<ConversationPlacementContextValue | null>(null);

function buildPlacementKey(workspaceId: string, sessionId?: string) {
  return `${workspaceId}:${sessionId ?? 'no-session'}`;
}

function createPlacementContainer() {
  const container = document.createElement('div');
  container.className = 'h-full min-h-0';
  return container;
}

function getPlacementSessionId(
  sessionId: string | undefined,
  interactive: boolean,
  sessionState: UseWorkspaceSessionsResult
) {
  if (sessionId) {
    return sessionId;
  }

  if (!interactive || sessionState.isNewSessionMode) {
    return undefined;
  }

  return sessionState.selectedSessionId;
}

export function KanbanSessionConversationPlacementProvider({
  children,
}: {
  children: ReactNode;
}) {
  const recordsRef = useRef(new Map<string, ConversationPlacementRecord>());
  const removalTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const [, setVersion] = useState(0);

  const bumpVersion = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  const mountSlot = useCallback<ConversationPlacementContextValue['mountSlot']>(
    (key, slotId, target, props) => {
      const removalTimer = removalTimersRef.current.get(key);
      if (removalTimer) {
        clearTimeout(removalTimer);
        removalTimersRef.current.delete(key);
      }

      let record = recordsRef.current.get(key);
      if (!record) {
        record = {
          key,
          container: createPlacementContainer(),
          props,
          slots: new Map(),
          activeSlotId: null,
        };
        recordsRef.current.set(key, record);
      }

      record.props = props;
      record.slots.set(slotId, target);
      record.activeSlotId = slotId;
      if (record.container.parentElement !== target) {
        target.appendChild(record.container);
      }
      bumpVersion();

      return () => {
        const currentRecord = recordsRef.current.get(key);
        if (!currentRecord) {
          return;
        }

        currentRecord.slots.delete(slotId);
        if (currentRecord.activeSlotId === slotId) {
          const nextSlots = Array.from(currentRecord.slots.entries());
          const nextSlot = nextSlots[nextSlots.length - 1];
          currentRecord.activeSlotId = nextSlot?.[0] ?? null;
          if (nextSlot) {
            nextSlot[1].appendChild(currentRecord.container);
          }
        }

        if (currentRecord.slots.size > 0) {
          bumpVersion();
          return;
        }

        const timer = setTimeout(() => {
          const latestRecord = recordsRef.current.get(key);
          if (!latestRecord || latestRecord.slots.size > 0) {
            return;
          }

          latestRecord.container.remove();
          recordsRef.current.delete(key);
          removalTimersRef.current.delete(key);
          bumpVersion();
        }, 250);
        removalTimersRef.current.set(key, timer);
      };
    },
    [bumpVersion]
  );

  useEffect(
    () => () => {
      for (const timer of removalTimersRef.current.values()) {
        clearTimeout(timer);
      }
      removalTimersRef.current.clear();
      for (const record of recordsRef.current.values()) {
        record.container.remove();
      }
      recordsRef.current.clear();
    },
    []
  );

  const contextValue = useMemo(
    () => ({
      mountSlot,
    }),
    [mountSlot]
  );
  const records = Array.from(recordsRef.current.values());

  return (
    <ConversationPlacementContext.Provider value={contextValue}>
      {children}
      {records.map((record) =>
        createPortal(
          <KanbanSessionConversationSurface {...record.props} />,
          record.container,
          record.key
        )
      )}
    </ConversationPlacementContext.Provider>
  );
}

function KanbanSessionConversationContent({
  attempt,
  taskId,
  interactive,
  sessionState,
  showSessionSelector,
  onSessionCreated,
  onSessionSelected,
  onCreateSessionRequested,
}: {
  attempt: WorkspaceWithSession;
  taskId: string | null;
  interactive: boolean;
  sessionState: UseWorkspaceSessionsResult;
  showSessionSelector: boolean;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onSessionSelected?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onCreateSessionRequested?: () => void;
}) {
  const logsRef = useRef<VirtualizedListRef | null>(null);
  const [isAtConversationBottom, setIsAtConversationBottom] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (!interactive) return;
    if (searchParams.get('newSession') !== '1') return;

    onCreateSessionRequested?.();
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('newSession');
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    interactive,
    onCreateSessionRequested,
    searchParams,
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
                  onCreateSessionRequested?.();
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
                onCreateSessionRequested={onCreateSessionRequested}
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

function KanbanSessionConversationSurface({
  workspaceId,
  sessionId,
  interactive = false,
  sessionState,
  showSessionSelector = false,
  onSessionCreated,
  onSessionSelected,
  onCreateSessionRequested,
  className,
}: KanbanSessionConversationSurfaceProps) {
  const { data: workspace, isLoading: isWorkspaceLoading } =
    useQuery<Workspace>({
      queryKey: ['taskAttempt', workspaceId],
      queryFn: () => attemptsApi.get(workspaceId),
      enabled: !!workspaceId,
      placeholderData: (previousData) =>
        previousData?.id === workspaceId ? previousData : undefined,
    });
  const sessionDetailQuery = getKanbanSessionDetailQueryState(sessionId);
  const {
    data: session,
    isError: isSessionError,
    isFetching: isSessionFetching,
  } = useQuery<SessionRecord>({
    queryKey: sessionDetailQuery.queryKey,
    queryFn: () => {
      if (!sessionDetailQuery.fetchSessionId) {
        throw new Error('Session id is required to fetch session details');
      }
      return sessionsApi.getById(
        sessionDetailQuery.fetchSessionId
      ) as Promise<SessionRecord>;
    },
    enabled: sessionDetailQuery.enabled,
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
        sessionState={sessionState}
        showSessionSelector={showSessionSelector}
        onSessionCreated={onSessionCreated}
        onSessionSelected={onSessionSelected}
        onCreateSessionRequested={onCreateSessionRequested}
      />
    </div>
  );
}

export function KanbanSessionConversationView(
  props: KanbanSessionConversationViewProps
) {
  const placement = useContext(ConversationPlacementContext);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const slotIdRef = useRef<string | null>(null);
  if (!slotIdRef.current) {
    slotIdRef.current = `slot-${Math.random().toString(36).slice(2)}`;
  }
  const slotId = slotIdRef.current;
  const interactive = props.interactive ?? false;
  const sessionState = useWorkspaceSessions(props.workspaceId, {
    initialSessionId: props.sessionId,
    enabled: interactive,
    autoSelectFirstSession: interactive,
  });
  const surfaceProps = useMemo<KanbanSessionConversationSurfaceProps>(
    () => ({
      ...props,
      interactive,
      sessionState,
    }),
    [interactive, props, sessionState]
  );
  const placementKey = buildPlacementKey(
    props.workspaceId,
    getPlacementSessionId(props.sessionId, interactive, sessionState)
  );

  useLayoutEffect(() => {
    if (!placement || !slotRef.current) {
      return;
    }

    return placement.mountSlot(
      placementKey,
      slotId,
      slotRef.current,
      surfaceProps
    );
  }, [placement, placementKey, slotId, surfaceProps]);

  if (!placement) {
    return <KanbanSessionConversationSurface {...surfaceProps} />;
  }

  return (
    <div ref={slotRef} className={`h-full min-h-0 ${props.className ?? ''}`} />
  );
}
