import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import { dateTimestamp } from '@/utils/date';
import { resolveCreateSessionHref } from '@/lib/createSessionHref';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { sessionsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  shouldShowLeftArrow,
  shouldShowRightArrow,
  getKanbanPanelTranslateX,
} from '@/lib/kanbanPanelView';
import type { SessionStatus } from '@/lib/api';
import {
  kanbanSlotOfZone,
  useKanbanArrangement,
} from '@/lib/layoutArrangement';
import { KanbanSessionHub } from '@/components/kanban/KanbanSessionHub';
import { KanbanSessionSlot } from '@/components/kanban/KanbanSessionSlot';
import { KanbanUsageDashboard } from '@/components/kanban/KanbanUsageDashboard';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import {
  ARCHIVED_SESSION_STATUS,
  SESSION_STATUS_LIGHT_COLORS,
  type ActiveSessionStatus,
} from '@/components/kanban/session-hub/utils';

const KANBAN_COLUMNS = [
  {
    key: 'todo' as ActiveSessionStatus,
    label: 'TODO',
    dotColor: SESSION_STATUS_LIGHT_COLORS.todo,
  },
  {
    key: 'inprogress' as ActiveSessionStatus,
    label: 'IN PROGRESS',
    dotColor: SESSION_STATUS_LIGHT_COLORS.inprogress,
  },
  {
    key: 'inreview' as ActiveSessionStatus,
    label: 'IN REVIEW',
    dotColor: SESSION_STATUS_LIGHT_COLORS.inreview,
  },
  {
    key: 'done' as ActiveSessionStatus,
    label: 'DONE',
    dotColor: SESSION_STATUS_LIGHT_COLORS.done,
  },
] as const;

function createEmptyStatusBuckets(): Record<
  ActiveSessionStatus,
  KanbanProjectSessionRecord[]
> {
  return {
    todo: [],
    inprogress: [],
    inreview: [],
    done: [],
  };
}

export function KanbanBoard() {
  const { t } = useTranslation(['panels', 'common']);
  const { panelView, goToBoard, goToSessionHub, goToUsageDashboard } =
    useKanbanSessionContext();
  const kanbanArrangement = useKanbanArrangement();
  const boardStyle = useKanbanBoardStyle();
  const canvasMode = boardStyle === 'canvas';
  useEffect(() => {
    if (canvasMode && panelView === 'board') {
      goToSessionHub();
    }
  }, [canvasMode, goToSessionHub, panelView]);
  const sessionSlotSide = kanbanSlotOfZone(kanbanArrangement, 'session');
  const canvasSessionView =
    canvasMode &&
    (panelView === 'sessionHub' || panelView === 'usageDashboard');
  // The center slot only exists inside the session hub; on the other views
  // the session column docks to the outer edge instead. Infinite canvas
  // absorbs the execution column entirely.
  const outerSessionSide: 'left' | 'right' =
    sessionSlotSide === 'left' ? 'left' : 'right';
  const outerSessionActive =
    !canvasSessionView &&
    (sessionSlotSide !== 'center' || panelView !== 'sessionHub');

  const showLeftArrow = canvasMode
    ? panelView === 'usageDashboard'
    : shouldShowLeftArrow(panelView);
  const showRightArrow = shouldShowRightArrow(panelView);

  const handleLeftArrowClick = () => {
    if (panelView === 'sessionHub') {
      goToBoard();
    } else if (panelView === 'usageDashboard') {
      goToSessionHub();
    }
  };

  const handleRightArrowClick = () => {
    if (panelView === 'board') {
      goToSessionHub();
    } else if (panelView === 'sessionHub') {
      goToUsageDashboard();
    }
  };

  const getLeftArrowLabel = () => {
    if (panelView === 'sessionHub') return t('kanbanPanel.backToBoard');
    if (panelView === 'usageDashboard')
      return t('kanbanPanel.backToSessionHub');
    return '';
  };

  const getRightArrowLabel = () => {
    if (panelView === 'board') return t('kanbanPanel.enterSessionHub');
    if (panelView === 'sessionHub') return t('kanbanPanel.enterUsageDashboard');
    return '';
  };

  return (
    <div className="flex h-full w-full" data-panel="kanban">
      {!canvasSessionView && outerSessionSide === 'left' && (
        <KanbanSessionSlot side="left" active={outerSessionActive} />
      )}
      <div className="kanban-shell group relative h-full min-w-0 flex-1 overflow-hidden">
        {/* Left arrow button */}
        {showLeftArrow && (
          <div className="absolute inset-y-0 left-0 z-20 flex w-10 items-center">
            <div className="flex h-24 w-full items-center">
              <button
                type="button"
                onClick={handleLeftArrowClick}
                aria-label={getLeftArrowLabel()}
                className={cn(
                  'kanban-nav-arrow ml-1 flex h-11 w-7 -translate-x-2 items-center justify-center rounded-r-full border opacity-0 transition-[opacity,transform,background-color,border-color,color] duration-200',
                  'pointer-events-none group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:opacity-100'
                )}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Right arrow button */}
        {showRightArrow && (
          <div className="absolute inset-y-0 right-0 z-20 flex w-10 items-center">
            <div className="flex h-24 w-full items-center justify-end">
              <button
                type="button"
                onClick={handleRightArrowClick}
                aria-label={getRightArrowLabel()}
                className={cn(
                  'kanban-nav-arrow mr-1 flex h-11 w-7 translate-x-2 items-center justify-center rounded-l-full border opacity-0 transition-[opacity,transform,background-color,border-color,color] duration-200',
                  'pointer-events-none group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:opacity-100'
                )}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <div
          className="flex h-full w-[300%] transition-transform duration-300 ease-out"
          style={{
            transform: getKanbanPanelTranslateX(panelView),
          }}
        >
          <div className="h-full w-1/3 shrink-0">
            <SessionKanbanBoard />
          </div>
          <div className="h-full w-1/3 shrink-0 border-x border-border/60">
            <KanbanSessionHub
              zoneOrder={[
                kanbanArrangement.left,
                kanbanArrangement.center,
                kanbanArrangement.right,
              ]}
              sessionSlot={
                sessionSlotSide === 'center' ? (
                  <KanbanSessionSlot
                    side="center"
                    active={panelView === 'sessionHub'}
                  />
                ) : null
              }
            />
          </div>
          <div className="h-full w-1/3 shrink-0">
            <KanbanUsageDashboard />
          </div>
        </div>
      </div>
      {!canvasSessionView && outerSessionSide === 'right' && (
        <KanbanSessionSlot side="right" active={outerSessionActive} />
      )}
    </div>
  );
}

function SessionKanbanBoard() {
  const { t } = useTranslation(['panels', 'common']);
  const { projectId } = useProject();
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const { pruneSessions, replaceRightSession } = useKanbanSessionContext();
  const queryClient = useQueryClient();

  const [activeSession, setActiveSession] =
    useState<KanbanProjectSessionRecord | null>(null);
  const [optimisticStatusBySessionId, setOptimisticStatusBySessionId] =
    useState<Record<string, SessionStatus>>({});

  const sessionsByStatus = useMemo(() => {
    const buckets = createEmptyStatusBuckets();

    sessions.forEach((session) => {
      const effectiveStatus =
        optimisticStatusBySessionId[session.id] ?? session.status;

      if (effectiveStatus === ARCHIVED_SESSION_STATUS) {
        return;
      }

      buckets[effectiveStatus as ActiveSessionStatus].push({
        ...session,
        status: effectiveStatus,
        isCompleted: effectiveStatus === 'done',
      });
    });

    (Object.values(buckets) as KanbanProjectSessionRecord[][]).forEach(
      (list) => {
        list.sort(
          (a, b) => dateTimestamp(b.updatedAt) - dateTimestamp(a.updatedAt)
        );
      }
    );

    return buckets;
  }, [optimisticStatusBySessionId, sessions]);

  useEffect(() => {
    setOptimisticStatusBySessionId((prev) => {
      let changed = false;
      const next = { ...prev };

      Object.entries(prev).forEach(([sessionId, optimisticStatus]) => {
        const latest = sessions.find((session) => session.id === sessionId);
        if (!latest || latest.status === optimisticStatus) {
          delete next[sessionId];
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [sessions]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const sessionId = event.active.id as string;
      const status = event.active.data.current?.parent as
        | ActiveSessionStatus
        | undefined;
      if (!status) return;
      const found = sessionsByStatus[status].find(
        (session) => session.id === sessionId
      );
      setActiveSession(found ?? null);
    },
    [sessionsByStatus]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveSession(null);
      const { active, over } = event;
      if (!over) return;

      const sessionId = active.id as string;
      const sourceStatus = active.data.current?.parent as
        | ActiveSessionStatus
        | undefined;
      const targetStatus = over.id as ActiveSessionStatus;

      if (!sourceStatus || sourceStatus === targetStatus) return;

      setOptimisticStatusBySessionId((prev) => ({
        ...prev,
        [sessionId]: targetStatus,
      }));

      void sessionsApi.updateStatus(sessionId, targetStatus).then(
        () => {
          queryClient.invalidateQueries({
            queryKey: ['workspaceSessions'],
          });
        },
        () => {
          setOptimisticStatusBySessionId((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
        }
      );
    },
    [queryClient]
  );

  const handleCreateSession = useCallback(
    (_status?: SessionStatus) => {
      if (!projectId) return;
      window.location.assign(
        resolveCreateSessionHref({
          projectId,
          isWorkspaceTab: false,
        })
      );
    },
    [projectId]
  );

  const handleSessionClick = useCallback(
    (session: KanbanProjectSessionRecord) => {
      replaceRightSession(session.placement);
    },
    [replaceRightSession]
  );

  const handleDeleteSession = useCallback(
    async (session: KanbanProjectSessionRecord) => {
      const result = await ConfirmDialog.show({
        title: t('kanbanPanel.deleteSessionTitle'),
        message: t('kanbanPanel.deleteSessionConfirm', {
          name: session.fullName,
        }),
        confirmText: t('common:delete'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });

      if (result !== 'confirmed') {
        return;
      }

      try {
        await sessionsApi.delete(session.id);
        await queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', session.workspace.id],
        });
        queryClient.removeQueries({
          queryKey: ['session', session.id],
        });

        const remainingSessionIds = new Set(
          sessions
            .map((candidate) => candidate.id)
            .filter((sessionId) => sessionId !== session.id)
        );
        pruneSessions(remainingSessionIds);
      } catch (error) {
        console.error('Failed to delete session:', error);
      }
    },
    [pruneSessions, queryClient, sessions, t]
  );

  if (isLoading) {
    return (
      <div className="kanban-loading-state flex h-full w-full items-center justify-center p-6 text-sm">
        {t('kanbanPanel.loadingBoard')}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={120}>
      <div className="kanban-board-surface h-full w-full overflow-auto p-3">
        <DndContext
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
          <div className="flex h-full min-w-0 gap-3">
            {KANBAN_COLUMNS.map((column) => (
              <SessionKanbanColumn
                key={column.key}
                columnKey={column.key}
                label={column.label}
                dotColor={column.dotColor}
                sessions={sessionsByStatus[column.key]}
                onSessionClick={handleSessionClick}
                onDeleteSession={handleDeleteSession}
                onCreateTask={() => handleCreateSession(column.key)}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeSession ? (
              <SessionHubListItem
                session={activeSession}
                marker={null}
                isDeleteMode={false}
                isSelected={false}
                onClick={() => undefined}
                onToggleSelect={() => undefined}
                displayMode="kanban-board"
                dragging
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </TooltipProvider>
  );
}

function SessionKanbanColumn({
  columnKey,
  label,
  dotColor,
  sessions,
  onSessionClick,
  onDeleteSession,
  onCreateTask,
}: {
  columnKey: ActiveSessionStatus;
  label: string;
  dotColor: string;
  sessions: KanbanProjectSessionRecord[];
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onDeleteSession: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onCreateTask: () => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { isOver, setNodeRef } = useDroppable({ id: columnKey });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'kanban-column-surface flex min-w-[180px] flex-1 flex-col rounded-xl transition-colors',
        isOver && 'is-over'
      )}
    >
      <div className="kanban-column-header flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="text-xs font-semibold tracking-wide text-foreground">
          {label}
        </span>
        <span className="kanban-count-pill ml-auto rounded-full px-2 py-0.5 text-xs">
          {sessions.length}
        </span>
        <button
          type="button"
          onClick={onCreateTask}
          className="kanban-add-button flex h-6 w-6 items-center justify-center rounded-md transition-colors"
          title={t('kanbanPanel.newSession')}
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto overflow-x-hidden p-2">
        {sessions.map((session, index) => (
          <DraggableSessionCard
            key={session.id}
            session={session}
            index={index}
            columnKey={columnKey}
            onClick={() => onSessionClick(session)}
            onDelete={() => onDeleteSession(session)}
          />
        ))}
      </div>
    </div>
  );
}

function DraggableSessionCard({
  session,
  index,
  columnKey,
  onClick,
  onDelete,
}: {
  session: KanbanProjectSessionRecord;
  index: number;
  columnKey: SessionStatus;
  onClick: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: session.id,
      data: { index, parent: columnKey },
    });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'min-w-0 cursor-grab',
        isDragging && 'cursor-grabbing opacity-0'
      )}
      style={{
        transform:
          transform && !isDragging
            ? `translateX(${transform.x}px) translateY(${transform.y}px)`
            : undefined,
      }}
    >
      <SessionHubListItem
        session={session}
        marker={null}
        isDeleteMode={false}
        isSelected={false}
        onClick={onClick}
        onToggleSelect={() => undefined}
        onDeleteSession={onDelete}
        displayMode="kanban-board"
      />
    </div>
  );
}

function DockviewKanbanPanel() {
  return <KanbanBoard />;
}

export default DockviewKanbanPanel;
