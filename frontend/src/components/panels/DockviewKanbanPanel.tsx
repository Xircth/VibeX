import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanNavArrow } from '@/components/kanban/KanbanNavArrow';
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
import { sessionsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useKanbanViews } from '@/hooks/useKanbanViews';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import {
  adjacentKanbanViewId,
  kanbanCarouselTranslateX,
  kanbanCarouselWidth,
  kanbanPageWidth,
  kanbanViewHidesSessionSlot,
  kanbanViewIndex,
  resolveKanbanViewId,
} from '@/lib/kanbanViews';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import type { SessionStatus } from '@/lib/api';
import {
  kanbanSlotOfZone,
  useKanbanArrangement,
} from '@/lib/layoutArrangement';
import { kanbanSessionRendersInHub } from '@/lib/kanbanZoneVisibility';
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
  const { activeViewId, setActiveViewId } = useKanbanSessionContext();
  const kanbanArrangement = useKanbanArrangement();
  const views = useKanbanViews();
  const boardStyle = useKanbanBoardStyle();
  const pluginViews = usePluginHostContributions('kanban_view');
  const resolvedViewId = resolveKanbanViewId(activeViewId, views, boardStyle);
  useEffect(() => {
    if (resolvedViewId && resolvedViewId !== activeViewId) {
      setActiveViewId(resolvedViewId);
    }
  }, [activeViewId, resolvedViewId, setActiveViewId]);
  const currentViewId = resolvedViewId ?? activeViewId;
  const currentIndex = kanbanViewIndex(views, currentViewId);
  const sessionSlotSide = kanbanSlotOfZone(kanbanArrangement, 'session');
  const hideSessionSlot = kanbanViewHidesSessionSlot(currentViewId);
  const sessionInHub = kanbanSessionRendersInHub(currentViewId);
  const outerSessionSide: 'left' | 'right' =
    sessionSlotSide === 'left' ? 'left' : 'right';
  const outerSessionActive = !hideSessionSlot && !sessionInHub;

  const showLeftArrow = currentIndex > 0;
  const showRightArrow = currentIndex < views.length - 1;

  const handleLeftArrowClick = () => {
    setActiveViewId(adjacentKanbanViewId(views, currentViewId, -1));
  };

  const handleRightArrowClick = () => {
    setActiveViewId(adjacentKanbanViewId(views, currentViewId, 1));
  };

  const getLeftArrowLabel = () => {
    const previous = views[currentIndex - 1];
    return previous
      ? t(previous.titleKey, { defaultValue: previous.titleKey })
      : '';
  };

  const getRightArrowLabel = () => {
    const next = views[currentIndex + 1];
    return next ? t(next.titleKey, { defaultValue: next.titleKey }) : '';
  };

  return (
    <div className="relative flex h-full w-full" data-panel="kanban">
      {!hideSessionSlot && outerSessionSide === 'left' && (
        <KanbanSessionSlot side="left" active={outerSessionActive} />
      )}
      <div className="kanban-shell relative h-full min-w-0 flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-out"
          style={{
            width: kanbanCarouselWidth(views.length),
            transform: kanbanCarouselTranslateX(views, currentViewId),
          }}
        >
          {views.map((view) => (
            <div
              key={view.id}
              className="h-full shrink-0"
              style={{ width: kanbanPageWidth(views.length) }}
              data-kanban-view={view.id}
            >
              <KanbanViewErrorBoundary>
                <KanbanRegisteredView
                  view={view}
                  active={view.id === currentViewId}
                  zoneOrder={[
                    kanbanArrangement.left,
                    kanbanArrangement.center,
                    kanbanArrangement.right,
                  ]}
                  sessionSlot={
                    view.id === 'builtin:sessions' ? (
                      <KanbanSessionSlot
                        side={sessionSlotSide}
                        active={currentViewId === 'builtin:sessions'}
                        inHub
                      />
                    ) : null
                  }
                  pluginItem={
                    view.pluginId
                      ? (pluginViews.find(
                          (item) =>
                            item.pluginId === view.pluginId &&
                            item.id === view.contributionId
                        ) ?? null)
                      : null
                  }
                />
              </KanbanViewErrorBoundary>
            </div>
          ))}
        </div>
      </div>
      {!hideSessionSlot && outerSessionSide === 'right' && (
        <KanbanSessionSlot side="right" active={outerSessionActive} />
      )}
      {showLeftArrow && (
        <KanbanNavArrow
          side="left"
          label={getLeftArrowLabel()}
          onClick={handleLeftArrowClick}
        />
      )}
      {showRightArrow && (
        <KanbanNavArrow
          side="right"
          label={getRightArrowLabel()}
          onClick={handleRightArrowClick}
        />
      )}
    </div>
  );
}

class KanbanViewErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <PluginSurfacePlaceholder
          reason="failed"
          onRecover={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}

function KanbanRegisteredView({
  view,
  active,
  zoneOrder,
  sessionSlot,
  pluginItem,
}: {
  view: { id: string; pluginId?: string };
  active: boolean;
  zoneOrder: Array<'list' | 'monitor' | 'session'>;
  sessionSlot: ReactNode;
  pluginItem: ReturnType<typeof usePluginHostContributions>[number] | null;
}) {
  if (view.id === 'builtin:columns') {
    return <SessionKanbanBoard />;
  }
  if (view.id === 'builtin:sessions') {
    return (
      <KanbanSessionHub
        presentation="fixed"
        zoneOrder={zoneOrder}
        sessionSlot={sessionSlot}
      />
    );
  }
  if (view.id === 'builtin:canvas') {
    return <KanbanSessionHub presentation="canvas" zoneOrder={zoneOrder} />;
  }
  if (view.id === 'builtin:usage') {
    return <KanbanUsageDashboard />;
  }
  return (
    <PluginRemoteView
      item={pluginItem}
      slot="app.kanban.view"
      enabled={active || pluginItem !== null}
    />
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
