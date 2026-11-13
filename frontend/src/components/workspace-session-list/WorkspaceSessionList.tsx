import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDndMonitor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronRight, Folder, Loader2, Pin } from 'lucide-react';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import {
  filterSessionListPreferences,
  useHideBotSessions,
  useHideDefaultWorkspace,
  useHideInactiveSessions,
} from '@/lib/sessionListFilters';
import { cn } from '@/lib/utils';

import {
  SESSION_ARCHIVE_DROP_ID,
  getSessionMarker,
  type SessionMarker,
} from '@/components/kanban/session-hub/utils';
import { getCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';
import {
  SESSION_LIST_DRAG_OVERLAY_CLASS,
  dragEndClientPoint,
  hitElementFromPoint,
  isPointOverCanvasDrop,
  sessionListCardWidthFromDragStart,
  sessionListDragOverlaySizeStyle,
} from '@/components/kanban/session-hub/sessionListDrag';
import { SessionListDragOverlay } from '@/components/kanban/session-hub/SessionListDragOverlay';
import type { KanbanSessionListView } from '@/lib/kanbanSessionListView';
import {
  SessionListAppearanceContext,
  useSessionListAppearance,
} from '@/lib/sessionListAppearance';
import {
  PINNED_SESSION_GROUP_ID,
  groupWorkspaceSessions,
  groupWorkspaceSessionsByStatus,
  moveSessionInOrder,
  pinnedWorkspaceSessions,
  readCollapsedWorkspaceIds,
  readWorkspaceSessionOrders,
  workspaceGroupStatusTone,
  writeCollapsedWorkspaceIds,
  writeWorkspaceSessionOrders,
  type SessionListSortSpec,
  type WorkspaceSessionGroup,
} from './workspaceSessionListModel';
import { WorkspaceSessionRow } from './WorkspaceSessionRow';
import {
  STATUS_LABEL_KEY,
  WorkspaceSessionStatusIndicator,
  WorkspaceSessionStatusLabel,
} from './WorkspaceSessionStatus';

export { WorkspaceSessionRow, WorkspaceSessionStatusIndicator };

interface WorkspaceSessionListProps {
  sessions: KanbanProjectSessionRecord[];
  isLoading: boolean;
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
  onArchiveSession?: (session: KanbanProjectSessionRecord) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onRestoreSession?: (session: KanbanProjectSessionRecord) => void;
  showPinnedSection?: boolean;
  isDeleteMode?: boolean;
  selectedSessionIds?: Set<string>;
  onToggleSessionSelection?: (sessionId: string) => void;
  dndContextProvided?: boolean;
  enableExternalDrag?: boolean;
  monitorPlacements?: Array<{ sessionId: string }>;
  currentExecutionPlacement?: { sessionId: string } | null;
  sortSpecs?: SessionListSortSpec[];
  viewMode?: KanbanSessionListView;
}

export function WorkspaceSessionList({
  sessions: rawSessions,
  isLoading,
  activeSessionId,
  activeWorkspaceId,
  onSessionClick,
  onPinSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
  showPinnedSection = false,
  isDeleteMode = false,
  selectedSessionIds,
  onToggleSessionSelection,
  dndContextProvided = false,
  enableExternalDrag = false,
  monitorPlacements = [],
  currentExecutionPlacement = null,
  sortSpecs = [],
  viewMode = 'workspace',
}: WorkspaceSessionListProps) {
  const { t } = useTranslation(['panels', 'common']);
  const appearance = useSessionListAppearance();
  const hideDefaultWorkspace = useHideDefaultWorkspace();
  const hideBotSessions = useHideBotSessions();
  const hideInactiveSessions = useHideInactiveSessions();
  const sessions = useMemo(
    () =>
      filterSessionListPreferences(rawSessions, {
        hideDefaultWorkspace,
        hideBotSessions,
        hideInactiveSessions,
      }),
    [hideBotSessions, hideDefaultWorkspace, hideInactiveSessions, rawSessions]
  );
  const [orderByWorkspace, setOrderByWorkspace] = useState(
    readWorkspaceSessionOrders
  );
  const groups = useMemo(() => {
    const statusOptions = {
      statusLabels: {
        todo: t(STATUS_LABEL_KEY.todo),
        inprogress: t(STATUS_LABEL_KEY.inprogress),
        inreview: t(STATUS_LABEL_KEY.inreview),
        done: t(STATUS_LABEL_KEY.done),
      },
      sessionOrderByGroup: orderByWorkspace,
      sortSpecs,
    };
    if (viewMode === 'status') {
      return groupWorkspaceSessionsByStatus(sessions, statusOptions);
    }
    const workspaceGroups = groupWorkspaceSessions(sessions, {
      activeWorkspaceId,
      sessionOrderByWorkspace: orderByWorkspace,
      sortSpecs,
    });
    return viewMode === 'mixed'
      ? workspaceGroups.map((group) => ({
          ...group,
          subgroups: groupWorkspaceSessionsByStatus(group.sessions, {
            ...statusOptions,
            groupIdPrefix: `${group.workspaceId}:`,
          }),
        }))
      : workspaceGroups;
  }, [activeWorkspaceId, orderByWorkspace, sessions, sortSpecs, t, viewMode]);
  const pinnedSessions = useMemo(
    () =>
      showPinnedSection ? pinnedWorkspaceSessions(sessions, sortSpecs) : [],
    [sessions, showPinnedSection, sortSpecs]
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(readCollapsedWorkspaceIds())
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragCardWidth, setActiveDragCardWidth] = useState<number | null>(
    null
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const reorderGroup = (workspaceId: string, nextIds: string[]) => {
    setOrderByWorkspace((current) => {
      const next = { ...current, [workspaceId]: nextIds };
      writeWorkspaceSessionOrders(next);
      return next;
    });
  };

  const prevActiveWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);

  useEffect(() => {
    const previousWorkspaceId = prevActiveWorkspaceIdRef.current;
    prevActiveWorkspaceIdRef.current = activeWorkspaceId;
    if (!activeWorkspaceId || activeWorkspaceId === previousWorkspaceId) {
      return;
    }

    setCollapsedIds((current) => {
      if (!current.has(activeWorkspaceId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(activeWorkspaceId);
      writeCollapsedWorkspaceIds(next);
      return next;
    });
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const matchingIds = [
      ...(pinnedSessions.some((session) => session.id === activeSessionId)
        ? [PINNED_SESSION_GROUP_ID]
        : []),
      ...groups
        .flatMap((group) => [group, ...(group.subgroups ?? [])])
        .filter((group) =>
          group.sessions.some((session) => session.id === activeSessionId)
        )
        .map((group) => group.workspaceId),
    ];
    if (matchingIds.length === 0) return;

    setCollapsedIds((current) => {
      const next = new Set(current);
      let changed = false;
      matchingIds.forEach((id) => {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      });
      if (!changed) return current;
      writeCollapsedWorkspaceIds(next);
      return next;
    });
  }, [activeSessionId, groups, pinnedSessions]);

  const toggleGroup = (workspaceId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      writeCollapsedWorkspaceIds(next);
      return next;
    });
  };

  const resolveDraggedSessionId = (
    event: Pick<DragStartEvent, 'active'>
  ): string => {
    const metaId = event.active.data?.current?.sessionId;
    if (typeof metaId === 'string' && metaId.length > 0) {
      return metaId;
    }
    const raw = String(event.active.id);
    const prefix = `${PINNED_SESSION_GROUP_ID}:`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  };

  const handleDragStart = (event: DragStartEvent) => {
    if (isDeleteMode) return;
    if (dndContextProvided && !enableExternalDrag && sortSpecs.length > 0) {
      return;
    }
    setActiveId(resolveDraggedSessionId(event));
    setActiveDragCardWidth(sessionListCardWidthFromDragStart(event));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over } = event;
    const draggedWidth =
      activeDragCardWidth ?? sessionListCardWidthFromDragStart(event);
    setActiveId(null);
    setActiveDragCardWidth(null);
    if (isDeleteMode) return;

    const activeSessionIdValue = resolveDraggedSessionId(event);
    if (!dndContextProvided) {
      const canvasController = getCanvasWorkspaceController();
      if (canvasController) {
        const client = dragEndClientPoint(event);
        if (
          client &&
          isPointOverCanvasDrop(hitElementFromPoint(client.x, client.y))
        ) {
          canvasController.dropSessionAt(
            activeSessionIdValue,
            client,
            draggedWidth
          );
          return;
        }
      }
    }

    if (
      enableExternalDrag ||
      sortSpecs.length > 0 ||
      !over ||
      over.id === SESSION_ARCHIVE_DROP_ID
    ) {
      return;
    }

    const overId = String(over.id);
    const group = groups
      .flatMap((group) => group.subgroups ?? [group])
      .find((candidate) =>
        candidate.sessions.some(
          (session) => session.id === activeSessionIdValue
        )
      );
    if (!group || !group.sessions.some((session) => session.id === overId)) {
      return;
    }

    const nextIds = moveSessionInOrder(
      group.sessions.map((session) => session.id),
      activeSessionIdValue,
      overId
    );
    if (nextIds) reorderGroup(group.workspaceId, nextIds);
  };

  const activeSession = sessions.find((session) => session.id === activeId);

  const renderGroup = (
    group: WorkspaceSessionGroup,
    nested = false
  ): ReactNode => (
    <WorkspaceSessionSection
      key={group.workspaceId}
      sectionId={group.workspaceId}
      label={group.label}
      icon={nested || viewMode === 'status' ? 'status' : 'folder'}
      nested={nested}
      sessions={group.sessions}
      expanded={!collapsedIds.has(group.workspaceId)}
      sortable={!isDeleteMode && !enableExternalDrag && sortSpecs.length === 0}
      externalDrag={
        enableExternalDrag ||
        (!dndContextProvided && !isDeleteMode && sortSpecs.length > 0)
      }
      activeSessionId={activeSessionId}
      isDeleteMode={isDeleteMode}
      selectedSessionIds={selectedSessionIds}
      monitorPlacements={monitorPlacements}
      currentExecutionPlacement={currentExecutionPlacement}
      onToggle={() => toggleGroup(group.workspaceId)}
      onSessionClick={onSessionClick}
      onToggleSessionSelection={onToggleSessionSelection}
      onPinSession={onPinSession}
      onArchiveSession={onArchiveSession}
      onRenameSession={onRenameSession}
      onDeleteSession={onDeleteSession}
      onRestoreSession={onRestoreSession}
    >
      {group.subgroups?.map((subgroup) => renderGroup(subgroup, true))}
    </WorkspaceSessionSection>
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('workspaceSessionList.loading')}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-5 text-center text-sm text-muted-foreground">
        {t('workspaceSessionList.empty')}
      </div>
    );
  }

  const list = (
    <SessionListAppearanceContext.Provider value={appearance}>
      {dndContextProvided ? (
        <WorkspaceSessionListDndMonitor
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setActiveId(null);
            setActiveDragCardWidth(null);
          }}
        />
      ) : null}
      <div className="workspace-session-list">
        {pinnedSessions.length > 0 ? (
          <WorkspaceSessionSection
            sectionId={PINNED_SESSION_GROUP_ID}
            label={t('workspaceSessionList.pinnedGroup')}
            icon="pin"
            sessions={pinnedSessions}
            expanded={!collapsedIds.has(PINNED_SESSION_GROUP_ID)}
            sortable={false}
            externalDrag={
              enableExternalDrag || (!dndContextProvided && !isDeleteMode)
            }
            activeSessionId={activeSessionId}
            isDeleteMode={isDeleteMode}
            selectedSessionIds={selectedSessionIds}
            monitorPlacements={monitorPlacements}
            currentExecutionPlacement={currentExecutionPlacement}
            onToggle={() => toggleGroup(PINNED_SESSION_GROUP_ID)}
            onSessionClick={onSessionClick}
            onToggleSessionSelection={onToggleSessionSelection}
            onPinSession={onPinSession}
            onArchiveSession={onArchiveSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onRestoreSession={onRestoreSession}
          />
        ) : null}
        {groups.map((group) => renderGroup(group))}
      </div>
      <SessionListDragOverlay>
        {activeSession ? (
          <div
            className={`${SESSION_LIST_DRAG_OVERLAY_CLASS} pointer-events-none`}
            style={sessionListDragOverlaySizeStyle(activeDragCardWidth)}
          >
            <WorkspaceSessionRow
              session={activeSession}
              isSelected={activeSession.id === activeSessionId}
              overlay
              onClick={() => undefined}
            />
          </div>
        ) : null}
      </SessionListDragOverlay>
    </SessionListAppearanceContext.Provider>
  );

  if (dndContextProvided) {
    return list;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setActiveDragCardWidth(null);
      }}
    >
      {list}
    </DndContext>
  );
}

function WorkspaceSessionListDndMonitor({
  onDragStart,
  onDragEnd,
  onDragCancel,
}: {
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
}) {
  useDndMonitor({
    onDragStart,
    onDragEnd,
    onDragCancel,
  });
  return null;
}

function WorkspaceSessionSection({
  sectionId,
  label,
  icon,
  nested = false,
  children,
  sessions,
  expanded,
  sortable,
  externalDrag,
  activeSessionId,
  isDeleteMode,
  selectedSessionIds,
  monitorPlacements,
  currentExecutionPlacement,
  onToggle,
  onSessionClick,
  onToggleSessionSelection,
  onPinSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
}: {
  sectionId: string;
  label: string;
  icon: 'pin' | 'folder' | 'status';
  nested?: boolean;
  children?: ReactNode;
  sessions: KanbanProjectSessionRecord[];
  expanded: boolean;
  sortable: boolean;
  externalDrag?: boolean;
  activeSessionId: string | null;
  isDeleteMode: boolean;
  selectedSessionIds?: Set<string>;
  monitorPlacements: Array<{ sessionId: string }>;
  currentExecutionPlacement: { sessionId: string } | null;
  onToggle: () => void;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onToggleSessionSelection?: (sessionId: string) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
  onArchiveSession?: (session: KanbanProjectSessionRecord) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onRestoreSession?: (session: KanbanProjectSessionRecord) => void;
}) {
  const listId = `workspace-session-group-${sectionId}`;
  const groupStatusTone = useMemo(
    () => workspaceGroupStatusTone(sessions),
    [sessions]
  );

  return (
    <section
      className={cn(
        'workspace-session-group min-w-0',
        nested && 'workspace-session-group--nested'
      )}
      data-status={icon === 'status' ? groupStatusTone : undefined}
    >
      <button
        type="button"
        className="workspace-session-group-header"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'workspace-session-group-chevron h-3 w-3 shrink-0',
            expanded && 'rotate-90'
          )}
        />
        {icon === 'pin' ? (
          <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : icon === 'folder' ? (
          <Folder
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        {icon === 'status' ? (
          <span className="min-w-0 flex-1 text-left">
            <WorkspaceSessionStatusLabel tone={groupStatusTone} />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left" title={label}>
            {label}
          </span>
        )}
        {icon === 'folder' ? (
          <WorkspaceSessionStatusIndicator
            tone={groupStatusTone}
            className="workspace-session-group-status"
          />
        ) : null}
        <span className="workspace-session-group-count">{sessions.length}</span>
      </button>
      {expanded && children ? (
        <div id={listId} className="workspace-session-subgroups">
          {children}
        </div>
      ) : expanded ? (
        <WorkspaceSessionGroupList
          listId={listId}
          sortableIdPrefix={sortable ? undefined : `${sectionId}:`}
          sessions={sessions}
          sortable={sortable}
          externalDrag={externalDrag}
          activeSessionId={activeSessionId}
          isDeleteMode={isDeleteMode}
          selectedSessionIds={selectedSessionIds}
          monitorPlacements={monitorPlacements}
          currentExecutionPlacement={currentExecutionPlacement}
          onSessionClick={onSessionClick}
          onToggleSessionSelection={onToggleSessionSelection}
          onPinSession={onPinSession}
          onArchiveSession={onArchiveSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onRestoreSession={onRestoreSession}
        />
      ) : null}
    </section>
  );
}

function sessionRowProps({
  session,
  activeSessionId,
  isDeleteMode,
  selectedSessionIds,
  monitorPlacements,
  currentExecutionPlacement,
  onSessionClick,
  onToggleSessionSelection,
  onPinSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
}: {
  session: KanbanProjectSessionRecord;
  activeSessionId: string | null;
  isDeleteMode: boolean;
  selectedSessionIds?: Set<string>;
  monitorPlacements: Array<{ sessionId: string }>;
  currentExecutionPlacement: { sessionId: string } | null;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onToggleSessionSelection?: (sessionId: string) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
  onArchiveSession?: (session: KanbanProjectSessionRecord) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onRestoreSession?: (session: KanbanProjectSessionRecord) => void;
}) {
  return {
    session,
    isSelected: isDeleteMode
      ? Boolean(selectedSessionIds?.has(session.id))
      : session.id === activeSessionId,
    isDeleteMode,
    marker: getSessionMarker(
      session.id,
      monitorPlacements,
      currentExecutionPlacement
    ),
    onClick: () => onSessionClick(session),
    onToggleSelect: onToggleSessionSelection
      ? () => onToggleSessionSelection(session.id)
      : undefined,
    onPin:
      !isDeleteMode && onPinSession
        ? (pinned: boolean) => onPinSession(session, pinned)
        : undefined,
    onArchive:
      !isDeleteMode && onArchiveSession
        ? () => onArchiveSession(session)
        : undefined,
    onRename:
      !isDeleteMode && onRenameSession
        ? (name: string | null) => onRenameSession(session, name)
        : undefined,
    onDelete:
      !isDeleteMode && onDeleteSession
        ? () => onDeleteSession(session)
        : undefined,
    onRestore:
      !isDeleteMode && onRestoreSession
        ? () => onRestoreSession(session)
        : undefined,
  };
}

function WorkspaceSessionGroupList({
  listId,
  sortableIdPrefix,
  sessions,
  sortable,
  externalDrag,
  activeSessionId,
  isDeleteMode,
  selectedSessionIds,
  monitorPlacements,
  currentExecutionPlacement,
  onSessionClick,
  onToggleSessionSelection,
  onPinSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
}: {
  listId: string;
  sortableIdPrefix?: string;
  sessions: KanbanProjectSessionRecord[];
  sortable: boolean;
  externalDrag?: boolean;
  activeSessionId: string | null;
  isDeleteMode: boolean;
  selectedSessionIds?: Set<string>;
  monitorPlacements: Array<{ sessionId: string }>;
  currentExecutionPlacement: { sessionId: string } | null;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onToggleSessionSelection?: (sessionId: string) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
  onArchiveSession?: (session: KanbanProjectSessionRecord) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onRestoreSession?: (session: KanbanProjectSessionRecord) => void;
}) {
  const sessionIds = sessions.map(
    (session) => `${sortableIdPrefix ?? ''}${session.id}`
  );
  const rows = sessions.map((session) => {
    const props = sessionRowProps({
      session,
      activeSessionId,
      isDeleteMode,
      selectedSessionIds,
      monitorPlacements,
      currentExecutionPlacement,
      onSessionClick,
      onToggleSessionSelection,
      onPinSession,
      onArchiveSession,
      onRenameSession,
      onDeleteSession,
      onRestoreSession,
    });

    if (!sortable) {
      if (externalDrag && !isDeleteMode) {
        const dragId = `${sortableIdPrefix ?? ''}${session.id}`;
        return (
          <DraggableWorkspaceSessionRow
            key={`${sortableIdPrefix ?? ''}${session.id}`}
            dragId={dragId}
            {...props}
          />
        );
      }
      return (
        <div
          key={`${sortableIdPrefix ?? ''}${session.id}`}
          className="max-w-full min-w-0"
        >
          <WorkspaceSessionRow {...props} />
        </div>
      );
    }

    return <SortableWorkspaceSessionRow key={session.id} {...props} />;
  });

  if (!sortable) {
    return (
      <div id={listId} role="list" className="workspace-session-rail">
        {rows}
      </div>
    );
  }

  return (
    <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
      <div id={listId} role="list" className="workspace-session-rail">
        {rows}
      </div>
    </SortableContext>
  );
}

function DraggableWorkspaceSessionRow({
  dragId,
  session,
  isSelected,
  isDeleteMode,
  marker,
  onClick,
  onToggleSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
  onRestore,
}: {
  dragId?: string;
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  isDeleteMode: boolean;
  marker: SessionMarker | null;
  onClick: () => void;
  onToggleSelect?: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
  onRename?: (name: string | null) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onRestore?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId ?? session.id,
    data: { sessionId: session.id },
    disabled: isDeleteMode,
  });

  return (
    <WorkspaceSessionRow
      session={session}
      isSelected={isSelected}
      isDeleteMode={isDeleteMode}
      marker={marker}
      onClick={onClick}
      onToggleSelect={onToggleSelect}
      onPin={onPin}
      onArchive={onArchive}
      onRename={onRename}
      onDelete={onDelete}
      onRestore={onRestore}
      setNodeRef={setNodeRef}
      style={{ opacity: isDragging ? 0 : undefined }}
      attributes={isDeleteMode ? undefined : attributes}
      listeners={isDeleteMode ? undefined : listeners}
      isDragging={isDragging}
    />
  );
}

function SortableWorkspaceSessionRow({
  session,
  isSelected,
  isDeleteMode,
  marker,
  onClick,
  onToggleSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
  onRestore,
}: {
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  isDeleteMode: boolean;
  marker: SessionMarker | null;
  onClick: () => void;
  onToggleSelect?: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
  onRename?: (name: string | null) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onRestore?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transition, isDragging } =
    useSortable({
      id: session.id,
      data: { sessionId: session.id },
      disabled: isDeleteMode,
      animateLayoutChanges: () => false,
    });

  return (
    <WorkspaceSessionRow
      session={session}
      isSelected={isSelected}
      isDeleteMode={isDeleteMode}
      marker={marker}
      onClick={onClick}
      onToggleSelect={onToggleSelect}
      onPin={onPin}
      onArchive={onArchive}
      onRename={onRename}
      onDelete={onDelete}
      onRestore={onRestore}
      setNodeRef={setNodeRef}
      style={{
        opacity: isDragging ? 0.4 : undefined,
        transition,
      }}
      attributes={isDeleteMode ? undefined : attributes}
      listeners={isDeleteMode ? undefined : listeners}
      isDragging={isDragging}
    />
  );
}
