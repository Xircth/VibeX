import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { openTaskForm } from '@/lib/openTaskForm';
import { sessionsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  shouldShowLeftArrow,
  shouldShowRightArrow,
  getKanbanPanelTranslateX,
} from '@/lib/kanbanPanelView';
import type { SessionStatus } from '@/lib/api';
import { KanbanSessionHub } from '@/components/kanban/KanbanSessionHub';
import { KanbanUsageDashboard } from '@/components/kanban/KanbanUsageDashboard';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import { SESSION_STATUS_LIGHT_COLORS } from '@/components/kanban/session-hub/utils';

const KANBAN_COLUMNS = [
  {
    key: 'todo' as SessionStatus,
    label: 'TODO',
    dotColor: SESSION_STATUS_LIGHT_COLORS.todo,
  },
  {
    key: 'inprogress' as SessionStatus,
    label: 'IN PROGRESS',
    dotColor: SESSION_STATUS_LIGHT_COLORS.inprogress,
  },
  {
    key: 'inreview' as SessionStatus,
    label: 'IN REVIEW',
    dotColor: SESSION_STATUS_LIGHT_COLORS.inreview,
  },
  {
    key: 'done' as SessionStatus,
    label: 'DONE',
    dotColor: SESSION_STATUS_LIGHT_COLORS.done,
  },
] as const;

function createEmptyStatusBuckets(): Record<
  SessionStatus,
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
  const { panelView, goToBoard, goToSessionHub, goToUsageDashboard } =
    useKanbanSessionContext();

  const showLeftArrow = shouldShowLeftArrow(panelView);
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
    if (panelView === 'sessionHub') return '返回看板';
    if (panelView === 'usageDashboard') return '返回会话中心';
    return '';
  };

  const getRightArrowLabel = () => {
    if (panelView === 'board') return '进入会话中心';
    if (panelView === 'sessionHub') return '进入计量统计';
    return '';
  };

  return (
    <div
      className="group relative h-full w-full overflow-hidden bg-background"
      data-panel="kanban"
    >
      {/* Left arrow button */}
      {showLeftArrow && (
        <div className="absolute inset-y-0 left-0 z-20 flex w-10 items-center">
          <div className="flex h-24 w-full items-center">
            <button
              type="button"
              onClick={handleLeftArrowClick}
              aria-label={getLeftArrowLabel()}
              className={cn(
                'ml-1 flex h-11 w-7 -translate-x-2 items-center justify-center rounded-r-full border border-border bg-background/95 text-muted-foreground opacity-0 shadow-sm transition-all duration-200 hover:text-foreground',
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
                'mr-1 flex h-11 w-7 translate-x-2 items-center justify-center rounded-l-full border border-border bg-background/95 text-muted-foreground opacity-0 shadow-sm transition-all duration-200 hover:text-foreground',
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
          <KanbanSessionHub />
        </div>
        <div className="h-full w-1/3 shrink-0">
          <KanbanUsageDashboard />
        </div>
      </div>
    </div>
  );
}

function SessionKanbanBoard() {
  const { projectId } = useProject();
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const { replaceRightSession } = useKanbanSessionContext();
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
      buckets[effectiveStatus].push({
        ...session,
        status: effectiveStatus,
        isCompleted: effectiveStatus === 'done',
      });
    });

    (Object.values(buckets) as KanbanProjectSessionRecord[][]).forEach(
      (list) => {
        list.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
        | SessionStatus
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
        | SessionStatus
        | undefined;
      const targetStatus = over.id as SessionStatus;

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

  const handleCreateTask = useCallback(
    (status?: SessionStatus) => {
      if (!projectId) return;
      openTaskForm({ mode: 'create', projectId, initialStatus: status });
    },
    [projectId]
  );

  const handleSessionClick = useCallback(
    (session: KanbanProjectSessionRecord) => {
      replaceRightSession(session.placement);
    },
    [replaceRightSession]
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在加载会话看板...
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background p-3">
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
              onCreateTask={() => handleCreateTask(column.key)}
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
  );
}

function SessionKanbanColumn({
  columnKey,
  label,
  dotColor,
  sessions,
  onSessionClick,
  onCreateTask,
}: {
  columnKey: SessionStatus;
  label: string;
  dotColor: string;
  sessions: KanbanProjectSessionRecord[];
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onCreateTask: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: columnKey });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-w-[180px] flex-1 flex-col rounded-lg border bg-muted/30 transition-colors',
        isOver ? 'border-primary bg-primary/5' : 'border-border'
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="text-xs font-semibold tracking-wide text-foreground">
          {label}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {sessions.length}
        </span>
        <button
          type="button"
          onClick={onCreateTask}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="新建任务"
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
}: {
  session: KanbanProjectSessionRecord;
  index: number;
  columnKey: SessionStatus;
  onClick: () => void;
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
      className={cn('min-w-0 cursor-grab', isDragging && 'cursor-grabbing opacity-0')}
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
        displayMode="kanban-board"
      />
    </div>
  );
}

function DockviewKanbanPanel() {
  return <KanbanBoard />;
}

export default DockviewKanbanPanel;
