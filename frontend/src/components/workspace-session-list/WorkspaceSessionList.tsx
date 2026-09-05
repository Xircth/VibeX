import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from 'react';
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
import {
  Archive,
  Bot,
  Check,
  FileCode,
  FileDown,
  Folder,
  GitFork,
  Loader2,
  Pencil,
  Pin,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { exportConversation } from '@/lib/exportConversation';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/utils/date';
import {
  SESSION_ARCHIVE_DROP_ID,
  getExecutorDisplayName,
  getSessionMarker,
  sessionListAgentKey,
  type SessionMarker,
} from '@/components/kanban/session-hub/utils';
import { SESSION_LIST_DRAG_OVERLAY_CLASS } from '@/components/kanban/session-hub/sessionListDrag';
import { SessionListDragOverlay } from '@/components/kanban/session-hub/SessionListDragOverlay';
import {
  PINNED_SESSION_GROUP_ID,
  formatCompactSessionAge,
  groupWorkspaceSessions,
  moveSessionInOrder,
  pinnedWorkspaceSessions,
  readCollapsedWorkspaceIds,
  readWorkspaceSessionOrders,
  sessionListTitle,
  workspaceSessionStatusTone,
  writeCollapsedWorkspaceIds,
  writeWorkspaceSessionOrders,
  type SessionListSortSpec,
  type WorkspaceSessionStatusTone,
} from './workspaceSessionListModel';

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
}

const STATUS_LABEL_KEY: Record<WorkspaceSessionStatusTone, string> = {
  todo: 'workspaceSessionList.statusTodo',
  inprogress: 'workspaceSessionList.statusInProgress',
  inreview: 'workspaceSessionList.statusInReview',
  done: 'workspaceSessionList.statusDone',
};

export function WorkspaceSessionList({
  sessions,
  isLoading,
  activeSessionId,
  activeWorkspaceId,
  onSessionClick,
  onPinSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
  showPinnedSection = true,
  isDeleteMode = false,
  selectedSessionIds,
  onToggleSessionSelection,
  dndContextProvided = false,
  enableExternalDrag = false,
  monitorPlacements = [],
  currentExecutionPlacement = null,
  sortSpecs = [],
}: WorkspaceSessionListProps) {
  const { t } = useTranslation(['panels']);
  const [orderByWorkspace, setOrderByWorkspace] = useState(
    readWorkspaceSessionOrders
  );
  const groups = useMemo(
    () =>
      groupWorkspaceSessions(sessions, {
        activeWorkspaceId,
        sessionOrderByWorkspace: orderByWorkspace,
        sortSpecs,
      }),
    [activeWorkspaceId, orderByWorkspace, sessions, sortSpecs]
  );
  const pinnedSessions = useMemo(
    () =>
      showPinnedSection ? pinnedWorkspaceSessions(sessions, sortSpecs) : [],
    [sessions, showPinnedSection, sortSpecs]
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(readCollapsedWorkspaceIds())
  );
  const [activeId, setActiveId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!activeSessionId) return;
    const matchingIds = [
      ...(pinnedSessions.some((session) => session.id === activeSessionId)
        ? [PINNED_SESSION_GROUP_ID]
        : []),
      ...groups
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

  const handleDragStart = ({ active }: DragStartEvent) => {
    if (isDeleteMode || sortSpecs.length > 0) return;
    setActiveId(String(active.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (
      enableExternalDrag ||
      isDeleteMode ||
      sortSpecs.length > 0 ||
      !over ||
      over.id === SESSION_ARCHIVE_DROP_ID
    ) {
      return;
    }

    const activeSessionIdValue = String(active.id);
    const overId = String(over.id);
    const group = groups.find((candidate) =>
      candidate.sessions.some((session) => session.id === activeSessionIdValue)
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
    <>
      {dndContextProvided ? (
        <WorkspaceSessionListDndMonitor
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        />
      ) : null}
      <div className="workspace-session-list space-y-2">
        {pinnedSessions.length > 0 ? (
          <WorkspaceSessionSection
            sectionId={PINNED_SESSION_GROUP_ID}
            label={t('workspaceSessionList.pinnedGroup')}
            icon="pin"
            sessions={pinnedSessions}
            expanded={!collapsedIds.has(PINNED_SESSION_GROUP_ID)}
            sortable={false}
            externalDrag={enableExternalDrag}
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
        {groups.map((group) => (
          <WorkspaceSessionSection
            key={group.workspaceId}
            sectionId={group.workspaceId}
            label={group.label}
            icon="folder"
            sessions={group.sessions}
            expanded={!collapsedIds.has(group.workspaceId)}
            sortable={!isDeleteMode && !enableExternalDrag}
            externalDrag={enableExternalDrag}
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
          />
        ))}
      </div>
      <SessionListDragOverlay>
        {activeSession ? (
          <div
            className={`${SESSION_LIST_DRAG_OVERLAY_CLASS} pointer-events-none w-[18rem] max-w-[18rem]`}
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
    </>
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
      onDragCancel={() => setActiveId(null)}
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
  icon: 'pin' | 'folder';
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
  const Icon = icon === 'pin' ? Pin : Folder;

  return (
    <section className="workspace-session-group min-w-0">
      <button
        type="button"
        className="workspace-session-group-header"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left" title={label}>
          {label}
        </span>
        <span className="workspace-session-group-count">{sessions.length}</span>
      </button>
      {expanded ? (
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
        return (
          <DraggableWorkspaceSessionRow
            key={`${sortableIdPrefix ?? ''}${session.id}`}
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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.id,
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

function WorkspaceSessionRow({
  session,
  isSelected,
  isDeleteMode = false,
  marker = null,
  onClick,
  onToggleSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
  onRestore,
  overlay = false,
  setNodeRef,
  style,
  attributes,
  listeners,
  isDragging = false,
}: {
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  isDeleteMode?: boolean;
  marker?: SessionMarker | null;
  onClick: () => void;
  onToggleSelect?: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
  onRename?: (name: string | null) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onRestore?: () => void;
  overlay?: boolean;
  setNodeRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  attributes?: HTMLAttributes<HTMLElement>;
  listeners?: HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}) {
  const { t } = useTranslation(['panels', 'tasks']);
  const title = sessionListTitle(session);
  const tone = workspaceSessionStatusTone(session);
  const statusLabel = t(STATUS_LABEL_KEY[tone]);
  const agentKey = sessionListAgentKey(session);
  const agentName = getExecutorDisplayName(agentKey);
  const compactAge = formatCompactSessionAge(session.updatedAt);
  const isPinned = Boolean(session.pinnedAt);
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const showRowActions =
    !isDeleteMode && Boolean(onPin || onRename || onDelete);

  useEffect(() => {
    if (!isEditing) {
      setDraftName(title);
    }
  }, [isEditing, title]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [contextMenu]);

  const submitRename = async () => {
    if (!onRename || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onRename(draftName.trim() || null);
      setIsEditing(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelRename = () => {
    setDraftName(title);
    setIsEditing(false);
    setIsSubmitting(false);
  };

  return (
    <div
      role="listitem"
      ref={setNodeRef}
      className="max-w-full min-w-0"
      style={style}
    >
      <div
        className={cn(
          'workspace-session-row',
          isSelected && 'is-selected',
          isDragging && 'is-dragging',
          overlay && 'is-overlay',
          isDeleteMode && 'is-delete-mode',
          isHovered && !isEditing && 'is-hovered'
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onContextMenu={(event) => {
          if (isDeleteMode) return;
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span
          className={cn(
            'workspace-session-row-marker',
            marker?.hue ? marker.bar : (marker?.bar ?? 'bg-muted-foreground/35')
          )}
          style={
            marker?.hue ? { backgroundColor: `hsl(${marker.hue})` } : undefined
          }
          aria-hidden="true"
        />
        {isDeleteMode ? (
          <div
            className="flex shrink-0 items-center pl-1.5"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect?.()}
            />
          </div>
        ) : null}
        {isEditing ? (
          <div className="workspace-session-row-main is-editing">
            <span className="workspace-session-icon" aria-hidden="true">
              {agentKey ? (
                <AgentIcon
                  agent={agentKey as ExecutorProfileId['executor']}
                  className="h-4 w-4"
                />
              ) : (
                <Bot className="h-4 w-4 text-muted-foreground" />
              )}
            </span>
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => void submitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitRename();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border-border/60 bg-[var(--surface-control)] text-xs"
              autoFocus
              disabled={isSubmitting}
            />
            <button
              type="button"
              className="workspace-session-row-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                void submitRename();
              }}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="workspace-session-row-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                cancelRename();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-current={isSelected ? 'true' : undefined}
              aria-label={
                session.isRunning
                  ? `${title}, ${agentName}, ${statusLabel}, ${t('workspaceSessionList.statusRunning')}`
                  : `${title}, ${agentName}, ${statusLabel}`
              }
              onClick={onClick}
              className="workspace-session-row-main"
              {...(overlay ? {} : attributes)}
              {...(overlay ? {} : listeners)}
            >
              <span className="workspace-session-icon" aria-hidden="true">
                {agentKey ? (
                  <AgentIcon
                    agent={agentKey as ExecutorProfileId['executor']}
                    className="h-4 w-4"
                  />
                ) : (
                  <Bot className="h-4 w-4 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    'workspace-session-status',
                    `workspace-session-status--${tone}`
                  )}
                />
              </span>
              <span className="workspace-session-title" title={title}>
                {title}
              </span>
              <span className="workspace-session-meta-idle">
                {session.isRunning ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin text-[hsl(var(--warning))]"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className="workspace-session-age"
                    title={formatRelativeTime(session.updatedAt)}
                  >
                    {compactAge}
                  </span>
                )}
              </span>
            </button>
            {showRowActions ? (
              <span className="workspace-session-row-actions">
                {onPin ? (
                  <button
                    type="button"
                    className={cn(
                      'workspace-session-row-action',
                      isPinned && 'is-active'
                    )}
                    aria-label={
                      isPinned
                        ? t('workspaceSessionList.unpin')
                        : t('workspaceSessionList.pin')
                    }
                    aria-pressed={isPinned}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPin(!isPinned);
                    }}
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {onRename ? (
                  <button
                    type="button"
                    className="workspace-session-row-action"
                    aria-label={t('workspaceSessionList.edit')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDraftName(title);
                      setIsEditing(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    className="workspace-session-row-action"
                    aria-label={t('workspaceSessionList.deleteSession')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDelete();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </span>
            ) : null}
          </>
        )}
      </div>
      {contextMenu ? (
        <div
          className="tahoe-popover fixed z-50 min-w-40 rounded-md p-1 text-popover-foreground"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
        >
          {onRestore ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setContextMenu(null);
                onRestore();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('workspaceSessionList.restore')}
            </button>
          ) : null}
          {onArchive ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setContextMenu(null);
                onArchive();
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              {t('workspaceSessionList.archive')}
            </button>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void conversationApi
                .fork(session.id)
                .then((result) => {
                  if (result.continuity === 'history_only') {
                    toast.warning(
                      t('tasks:hubListItem.forkHistoryOnly', {
                        reason: result.continuityNote,
                      })
                    );
                    return;
                  }
                  toast.success(t('tasks:hubListItem.forkSuccess'));
                })
                .catch((error) =>
                  toast.error(
                    t('tasks:hubListItem.forkFailed', {
                      error: String(error),
                    })
                  )
                );
            }}
          >
            <GitFork className="h-3.5 w-3.5" />
            {t('tasks:hubListItem.forkSession')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void exportConversation(
                session.id,
                'markdown',
                session.name ?? t('tasks:hubListItem.sessionFallback')
              );
            }}
          >
            <FileDown className="h-3.5 w-3.5" />
            {t('tasks:hubListItem.exportAsMarkdown')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void exportConversation(
                session.id,
                'html',
                session.name ?? t('tasks:hubListItem.sessionFallback')
              );
            }}
          >
            <FileCode className="h-3.5 w-3.5" />
            {t('tasks:hubListItem.exportAsHtml')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
