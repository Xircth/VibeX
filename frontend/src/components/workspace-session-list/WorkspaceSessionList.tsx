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
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { CSS } from '@dnd-kit/utilities';
import {
  Archive,
  Bot,
  FileCode,
  FileDown,
  Folder,
  GitFork,
  Loader2,
  Pin,
} from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { exportConversation } from '@/lib/exportConversation';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/utils/date';
import { getExecutorDisplayName } from '@/components/kanban/session-hub/utils';
import {
  formatCompactSessionAge,
  groupWorkspaceSessions,
  moveSessionInOrder,
  readCollapsedWorkspaceIds,
  readWorkspaceSessionOrders,
  sessionListTitle,
  workspaceSessionStatusTone,
  writeCollapsedWorkspaceIds,
  writeWorkspaceSessionOrders,
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
      }),
    [activeWorkspaceId, orderByWorkspace, sessions]
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(readCollapsedWorkspaceIds())
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
    const activeGroup = groups.find((group) =>
      group.sessions.some((session) => session.id === activeSessionId)
    );
    if (!activeGroup) return;

    setCollapsedIds((current) => {
      if (!current.has(activeGroup.workspaceId)) return current;
      const next = new Set(current);
      next.delete(activeGroup.workspaceId);
      writeCollapsedWorkspaceIds(next);
      return next;
    });
  }, [activeSessionId, groups]);

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

  return (
    <div className="workspace-session-list space-y-3">
      {groups.map((group) => {
        const expanded = !collapsedIds.has(group.workspaceId);
        const listId = `workspace-session-group-${group.workspaceId}`;
        return (
          <section
            key={group.workspaceId}
            className="workspace-session-group min-w-0"
          >
            <button
              type="button"
              className="workspace-session-group-header"
              aria-label={group.label}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => toggleGroup(group.workspaceId)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span
                className="min-w-0 flex-1 truncate text-left"
                title={group.label}
              >
                {group.label}
              </span>
              <span className="workspace-session-group-count">
                {group.sessions.length}
              </span>
            </button>
            {expanded ? (
              <WorkspaceSessionGroupList
                listId={listId}
                sessions={group.sessions}
                activeSessionId={activeSessionId}
                onSessionClick={onSessionClick}
                onPinSession={onPinSession}
                onArchiveSession={onArchiveSession}
                onReorder={(nextIds) =>
                  reorderGroup(group.workspaceId, nextIds)
                }
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function WorkspaceSessionGroupList({
  listId,
  sessions,
  activeSessionId,
  onSessionClick,
  onPinSession,
  onArchiveSession,
  onReorder,
}: {
  listId: string;
  sessions: KanbanProjectSessionRecord[];
  activeSessionId: string | null;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
  onArchiveSession?: (session: KanbanProjectSessionRecord) => void;
  onReorder: (nextIds: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const sessionIds = sessions.map((session) => session.id);
  const activeSession = sessions.find((session) => session.id === activeId);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over) return;
    const nextIds = moveSessionInOrder(
      sessionIds,
      String(active.id),
      String(over.id)
    );
    if (nextIds) onReorder(nextIds);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext
        items={sessionIds}
        strategy={verticalListSortingStrategy}
      >
        <div id={listId} role="list" className="workspace-session-rail">
          {sessions.map((session) => (
            <SortableWorkspaceSessionRow
              key={session.id}
              session={session}
              isSelected={session.id === activeSessionId}
              onClick={() => onSessionClick(session)}
              onPin={
                onPinSession
                  ? (pinned) => onPinSession(session, pinned)
                  : undefined
              }
              onArchive={
                onArchiveSession ? () => onArchiveSession(session) : undefined
              }
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeSession ? (
          <WorkspaceSessionRow
            session={activeSession}
            isSelected={activeSession.id === activeSessionId}
            overlay
            onClick={() => undefined}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableWorkspaceSessionRow({
  session,
  isSelected,
  onClick,
  onPin,
  onArchive,
}: {
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  onClick: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    animateLayoutChanges: () => false,
  });

  return (
    <WorkspaceSessionRow
      session={session}
      isSelected={isSelected}
      onClick={onClick}
      onPin={onPin}
      onArchive={onArchive}
      setNodeRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      attributes={attributes}
      listeners={listeners}
      isDragging={isDragging}
    />
  );
}

function WorkspaceSessionRow({
  session,
  isSelected,
  onClick,
  onPin,
  onArchive,
  overlay = false,
  setNodeRef,
  style,
  attributes,
  listeners,
  isDragging = false,
}: {
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  onClick: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
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
  const agentName = getExecutorDisplayName(session.executor);
  const compactAge = formatCompactSessionAge(session.updatedAt);
  const isPinned = Boolean(session.pinnedAt);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

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

  return (
    <div role="listitem" ref={setNodeRef} className="min-w-0" style={style}>
      <div
        className={cn(
          'workspace-session-row',
          isSelected && 'is-selected',
          isDragging && 'is-dragging',
          overlay && 'is-overlay'
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
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
            {session.executor ? (
              <AgentIcon
                agent={session.executor as ExecutorProfileId['executor']}
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
          <span
            className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground"
            title={title}
          >
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
        {onPin || onArchive ? (
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
            {onArchive ? (
              <button
                type="button"
                className="workspace-session-row-action"
                aria-label={t('workspaceSessionList.archive')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onArchive();
                }}
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          className="tahoe-popover fixed z-50 min-w-40 rounded-md p-1 text-popover-foreground"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
        >
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
