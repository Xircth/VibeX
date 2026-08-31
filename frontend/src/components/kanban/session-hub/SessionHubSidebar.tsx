import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  Archive,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ListFilter,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Workspace,
  ExecutorConfigs,
  ExecutorProfileId,
} from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import type { SessionStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { WorkspaceSessionList } from '@/components/workspace-session-list/WorkspaceSessionList';
import { useKanbanSessionListView } from '@/lib/kanbanSessionListView';
import { cn } from '@/lib/utils';
import type {
  SessionControlsPreset,
  SessionCreationMode,
} from '@/components/sessions/SessionCreationForm';
import type { WorkspaceBranchOption } from '@/lib/workspaceBranchOptions';
import { SessionHubListItem } from './SessionHubListItem';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
  SESSION_ARCHIVE_DROP_ID,
  SESSION_LIST_NOTICE_DURATION_MS,
  ARCHIVED_SESSION_STATUS,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_ORDER,
  SESSION_STATUS_SECTION_STYLES,
  type ActiveSessionStatus,
  filterKanbanSessions,
  getSessionMarker,
  getSortLabel,
  toggleStringValue,
  type SortField,
} from './utils';

interface ExecutorFilterOption {
  value: string;
  label: string;
}

interface SessionHubSidebarProps {
  width: number;
  fill?: boolean;
  isLoading: boolean;
  sessions: KanbanProjectSessionRecord[];
  archivedSessions: KanbanProjectSessionRecord[];
  groupedSessions: Record<string, KanbanProjectSessionRecord[]>;
  flatSessions: KanbanProjectSessionRecord[];
  workspaces: Workspace[];
  workspaceBranchOptions: WorkspaceBranchOption[];
  profiles: ExecutorConfigs['executors'] | null;
  createMode: SessionCreationMode;
  createWorkspaceValue: string;
  createSessionName: string;
  selectedExecutorProfile: ExecutorProfileId | null;
  repoBranchConfigs: RepoBranchConfig[];
  isLoadingRepoBranches: boolean;
  isCreatePopoverOpen: boolean;
  sortField: SortField | null;
  workspaceFilterIds: string[];
  executorFilterValues: string[];
  executorFilterOptions: ExecutorFilterOption[];
  expandedSections: Record<string, boolean>;
  isDeleteMode: boolean;
  selectedSessionIdSet: Set<string>;
  deleteErrorMessage: string | null;
  deleteSuccessMessage: string | null;
  isDeletingSessions: boolean;
  canCreateSession: boolean;
  isCreatePending: boolean;
  createError: unknown;
  displayedCount: number;
  monitorPlacements: Array<{ sessionId: string }>;
  currentExecutionPlacement: { sessionId: string } | null;
  openingSessionId?: string | null;
  activeWorkspaceId?: string | null;
  isArchiveView: boolean;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onArchiveViewChange: (value: boolean) => void;
  onCreateSessionRequested: () => void;
  onCreatePopoverOpenChange?: (open: boolean) => void;
  onCreateSession?: () => void;
  onSessionControlsPresetChange?: (
    preset: SessionControlsPreset | null
  ) => void;
  onCreateModeChange: (value: SessionCreationMode) => void;
  onCreateWorkspaceValueChange: (value: string) => void;
  onCreateSessionNameChange: (value: string) => void;
  onSelectedExecutorProfileChange: (value: ExecutorProfileId) => void;
  onRepoBranchChange: (repoId: string, branch: string) => void;
  onSortFieldChange: (value: SortField | null) => void;
  onWorkspaceFilterIdsChange: (value: string[]) => void;
  onExecutorFilterValuesChange: (value: string[]) => void;
  onResetViewState: () => void;
  onToggleDeleteMode: () => void;
  onCancelDeleteMode: () => void;
  onDeleteSelectedSessions: () => Promise<void>;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onToggleSessionSelection: (sessionId: string) => void;
  onRenameSession: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onSessionStatusChange: (
    session: KanbanProjectSessionRecord,
    nextStatus: SessionStatus
  ) => void;
  onRestoreArchivedSession: (session: KanbanProjectSessionRecord) => void;
  onExpandedChange: (status: string, expanded: boolean) => void;
  onPinSession?: (session: KanbanProjectSessionRecord, pinned: boolean) => void;
}

const STATUS_DROP_ID_PREFIX = 'session-status-drop:';

function getStatusDropId(status: ActiveSessionStatus) {
  return `${STATUS_DROP_ID_PREFIX}${status}`;
}

function parseStatusDropId(id: unknown): ActiveSessionStatus | null {
  if (typeof id !== 'string' || !id.startsWith(STATUS_DROP_ID_PREFIX)) {
    return null;
  }

  const value = id.slice(STATUS_DROP_ID_PREFIX.length) as ActiveSessionStatus;
  if (!SESSION_STATUS_ORDER.includes(value)) {
    return null;
  }

  return value;
}

function SessionListNotice({
  variant,
  children,
  onDismiss,
}: {
  variant: 'success' | 'error';
  children: ReactNode;
  onDismiss: () => void;
}) {
  const { t } = useTranslation(['common']);
  const Icon = variant === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-4',
        variant === 'success'
          ? 'border-[hsl(var(--success)/0.32)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]'
          : 'border-[hsl(var(--destructive)/0.32)] bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))]'
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button
        type="button"
        className="shrink-0 rounded-md p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
        aria-label={t('close')}
        onClick={onDismiss}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function SectionLabel({
  status,
  title,
  count,
  expanded,
  onToggle,
}: {
  status: ActiveSessionStatus;
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusStyle = SESSION_STATUS_SECTION_STYLES[status];

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/40"
    >
      <div
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
          statusStyle.pill
        )}
      >
        {expanded ? (
          <ChevronDown className={cn('h-3.5 w-3.5', statusStyle.text)} />
        ) : (
          <ChevronRight className={cn('h-3.5 w-3.5', statusStyle.text)} />
        )}
        <span className={cn('text-xs font-medium', statusStyle.text)}>
          {title}
        </span>
      </div>
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[10px]',
          statusStyle.count
        )}
      >
        {count}
      </span>
    </button>
  );
}

function StatusDropZone({
  status,
  enabled,
  children,
}: {
  status: ActiveSessionStatus;
  enabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: getStatusDropId(status),
    disabled: !enabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'session-hub-drop-zone session-hub-status-zone rounded-xl p-2 transition-colors',
        isOver && enabled ? 'is-over' : ''
      )}
    >
      {children}
    </div>
  );
}

function ArchiveDropZone({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation(['tasks', 'common']);
  const { setNodeRef, isOver } = useDroppable({
    id: SESSION_ARCHIVE_DROP_ID,
    disabled: !enabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'session-hub-drop-zone rounded-xl border border-dashed px-3 py-2 transition-colors',
        enabled
          ? 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] text-primary'
          : 'text-muted-foreground',
        isOver && enabled
          ? 'is-over border-[hsl(var(--primary)/0.7)] bg-[hsl(var(--primary)/0.18)]'
          : ''
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <Archive className="h-3.5 w-3.5" />
        {t('hubSidebar.dragHereToArchive')}
      </div>
    </div>
  );
}

function DraggableSessionCard({
  session,
  status,
  isDeleteMode,
  isSelected,
  monitorPlacements,
  currentExecutionPlacement,
  openingSessionId = null,
  onSessionClick,
  onToggleSessionSelection,
  onRenameSession,
  onDeleteSession,
}: {
  session: KanbanProjectSessionRecord;
  status: ActiveSessionStatus;
  isDeleteMode: boolean;
  isSelected: boolean;
  monitorPlacements: Array<{ sessionId: string }>;
  currentExecutionPlacement: { sessionId: string } | null;
  openingSessionId: string | null;
  onSessionClick: (session: KanbanProjectSessionRecord) => void;
  onToggleSessionSelection: (sessionId: string) => void;
  onRenameSession: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: session.id,
      data: { parentStatus: status },
      disabled: isDeleteMode,
    });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'w-full max-w-full min-w-0 overflow-hidden touch-none',
        !isDeleteMode && 'cursor-grab'
      )}
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        opacity: isDragging ? 0.25 : undefined,
      }}
    >
      <SessionHubListItem
        session={session}
        marker={getSessionMarker(
          session.id,
          monitorPlacements,
          currentExecutionPlacement
        )}
        isDeleteMode={isDeleteMode}
        isSelected={isSelected}
        onClick={() => onSessionClick(session)}
        onToggleSelect={() => onToggleSessionSelection(session.id)}
        onRenameSession={(name) => onRenameSession(session, name)}
        onDeleteSession={
          onDeleteSession ? () => onDeleteSession(session) : undefined
        }
        dragging={isDragging}
        isOpening={openingSessionId === session.id}
      />
    </div>
  );
}

function renderSessionList(
  sessions: KanbanProjectSessionRecord[],
  status: ActiveSessionStatus | null,
  enableDrag: boolean,
  isDeleteMode: boolean,
  selectedSessionIdSet: Set<string>,
  monitorPlacements: Array<{ sessionId: string }>,
  currentExecutionPlacement: { sessionId: string } | null,
  openingSessionId: string | null,
  onSessionClick: (session: KanbanProjectSessionRecord) => void,
  onToggleSessionSelection: (sessionId: string) => void,
  onRenameSession: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>,
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>,
  onRestoreArchivedSession?: (session: KanbanProjectSessionRecord) => void
) {
  return (
    <div className="w-full max-w-full min-w-0 space-y-1.5">
      {sessions.map((session) =>
        enableDrag && status ? (
          <DraggableSessionCard
            key={session.id}
            session={session}
            status={status}
            isDeleteMode={isDeleteMode}
            isSelected={selectedSessionIdSet.has(session.id)}
            monitorPlacements={monitorPlacements}
            currentExecutionPlacement={currentExecutionPlacement}
            openingSessionId={openingSessionId}
            onSessionClick={onSessionClick}
            onToggleSessionSelection={onToggleSessionSelection}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
          />
        ) : (
          <SessionHubListItem
            key={session.id}
            session={session}
            marker={getSessionMarker(
              session.id,
              monitorPlacements,
              currentExecutionPlacement
            )}
            isDeleteMode={isDeleteMode}
            isSelected={selectedSessionIdSet.has(session.id)}
            onClick={() => onSessionClick(session)}
            onToggleSelect={() => onToggleSessionSelection(session.id)}
            onRenameSession={(name) => onRenameSession(session, name)}
            onDeleteSession={
              onDeleteSession ? () => onDeleteSession(session) : undefined
            }
            onRestoreFromArchive={
              onRestoreArchivedSession
                ? () => onRestoreArchivedSession(session)
                : undefined
            }
            isOpening={openingSessionId === session.id}
          />
        )
      )}
    </div>
  );
}

export function SessionHubSidebar({
  width,
  fill = false,
  isLoading,
  sessions,
  archivedSessions,
  groupedSessions,
  flatSessions,
  workspaces,
  sortField,
  workspaceFilterIds,
  executorFilterValues,
  executorFilterOptions,
  expandedSections,
  isDeleteMode,
  selectedSessionIdSet,
  deleteErrorMessage,
  deleteSuccessMessage,
  isDeletingSessions,
  displayedCount,
  monitorPlacements,
  currentExecutionPlacement,
  openingSessionId = null,
  activeWorkspaceId = null,
  isArchiveView,
  onResizeMouseDown,
  onArchiveViewChange,
  onCreateSessionRequested,
  onSortFieldChange,
  onWorkspaceFilterIdsChange,
  onExecutorFilterValuesChange,
  onResetViewState,
  onToggleDeleteMode,
  onCancelDeleteMode,
  onDeleteSelectedSessions,
  onSessionClick,
  onToggleSessionSelection,
  onRenameSession,
  onDeleteSession,
  onSessionStatusChange,
  onRestoreArchivedSession,
  onExpandedChange,
  onPinSession,
}: SessionHubSidebarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const listView = useKanbanSessionListView();
  const hasActiveFilters =
    workspaceFilterIds.length > 0 || executorFilterValues.length > 0;
  const isWorkspaceListView =
    listView === 'workspace' && !isArchiveView && !isDeleteMode;
  const isFlatListMode =
    !isArchiveView &&
    !isWorkspaceListView &&
    (hasActiveFilters || sortField !== null);
  const canDragToArchive = !isArchiveView && !isDeleteMode && !isFlatListMode;
  const canDragAcrossSections = canDragToArchive && !isWorkspaceListView;
  const [activeDragSessionId, setActiveDragSessionId] = useState<string | null>(
    null
  );
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const noticeMessage = deleteErrorMessage ?? deleteSuccessMessage;
  const noticeVariant = deleteErrorMessage
    ? ('error' as const)
    : deleteSuccessMessage
      ? ('success' as const)
      : null;
  const visibleNotice =
    noticeMessage && noticeVariant && noticeMessage !== dismissedNotice
      ? { variant: noticeVariant, message: noticeMessage }
      : null;
  const sessionsById = useMemo(
    () =>
      sessions.reduce<Record<string, KanbanProjectSessionRecord>>(
        (accumulator, session) => {
          accumulator[session.id] = session;
          return accumulator;
        },
        {}
      ),
    [sessions]
  );
  const workspaceListSessions = useMemo(
    () =>
      filterKanbanSessions({
        sessions,
        workspaceFilterIds,
        executorFilterValues,
      }),
    [executorFilterValues, sessions, workspaceFilterIds]
  );
  const activeSessionId =
    currentExecutionPlacement?.sessionId ?? openingSessionId ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  useEffect(() => {
    setDismissedNotice(null);
  }, [deleteErrorMessage, deleteSuccessMessage]);

  useEffect(() => {
    if (!noticeMessage || noticeMessage === dismissedNotice) return;

    const timeoutId = window.setTimeout(() => {
      setDismissedNotice(noticeMessage);
    }, SESSION_LIST_NOTICE_DURATION_MS);

    return () => window.clearTimeout(timeoutId);
  }, [dismissedNotice, noticeMessage]);

  const handleDragStart = (event: DragStartEvent) => {
    if (!canDragToArchive) return;
    setActiveDragSessionId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragSessionId(null);
    if (!event.over) {
      return;
    }

    const sessionId = String(event.active.id);
    const session = sessionsById[sessionId];
    if (!session) {
      return;
    }

    if (event.over.id === SESSION_ARCHIVE_DROP_ID) {
      if (canDragToArchive) {
        onSessionStatusChange(session, ARCHIVED_SESSION_STATUS);
      }
      return;
    }

    if (!canDragAcrossSections) {
      return;
    }

    const targetStatus = parseStatusDropId(event.over.id);
    if (!targetStatus || targetStatus === session.status) {
      return;
    }

    onSessionStatusChange(session, targetStatus);
  };

  const showArchiveDrop = Boolean(activeDragSessionId) && canDragToArchive;
  const insetExpanded = showArchiveDrop || Boolean(visibleNotice);

  const visibleCount = isArchiveView ? archivedSessions.length : displayedCount;
  const totalCount = isArchiveView ? archivedSessions.length : sessions.length;

  return (
    <>
      <aside
        className={cn(
          'session-hub-sidebar flex h-full min-h-0 flex-col',
          fill ? 'min-w-0 flex-1' : 'shrink-0'
        )}
        style={{ width: fill ? '100%' : `${width}px` }}
      >
        <div className="space-y-2 px-2.5 pb-1 pt-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 cursor-default truncate text-sm font-semibold text-foreground">
                    {isArchiveView
                      ? t('hubSidebar.archiveArea')
                      : t('hubSidebar.sessionList')}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {visibleCount} / {totalCount}
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={SESSION_LIST_ACTION_BUTTON_CLASS}
                    aria-label={t('hubSidebar.newSession')}
                    onClick={onCreateSessionRequested}
                  >
                    <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('hubSidebar.newSession')}</TooltipContent>
              </Tooltip>

              {isWorkspaceListView ? null : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        SESSION_LIST_ACTION_BUTTON_CLASS,
                        sortField && 'text-foreground'
                      )}
                      aria-label={t('hubSidebar.sort')}
                    >
                      <ArrowUpDown className={SESSION_LIST_ACTION_ICON_CLASS} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={sortField ?? 'default'}
                      onValueChange={(value) =>
                        onSortFieldChange(
                          value === 'default' ? null : (value as SortField)
                        )
                      }
                    >
                      <DropdownMenuRadioItem value="default">
                        {t('hubSidebar.sortDefault')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="name">
                        {t('hubSidebar.sortName')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="time">
                        {t('hubSidebar.sortTime')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="status">
                        {t('hubSidebar.sortStatus')}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <Popover>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          SESSION_LIST_ACTION_BUTTON_CLASS,
                          hasActiveFilters && 'text-foreground'
                        )}
                        aria-label={t('hubSidebar.filter')}
                      >
                        <ListFilter
                          className={SESSION_LIST_ACTION_ICON_CLASS}
                        />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('hubSidebar.filter')}</TooltipContent>
                </Tooltip>

                <PopoverContent
                  align="start"
                  className="w-[280px] space-y-3 p-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-foreground">
                      {t('hubSidebar.filterConditions')}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        onWorkspaceFilterIdsChange([]);
                        onExecutorFilterValuesChange([]);
                      }}
                    >
                      {t('hubSidebar.clear')}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {t('hubSidebar.workspace')}
                    </div>
                    <ScrollArea className="max-h-32">
                      <div className="space-y-2 pr-3">
                        {workspaces.map((workspace) => (
                          <label
                            key={workspace.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/40"
                          >
                            <Checkbox
                              checked={workspaceFilterIds.includes(
                                workspace.id
                              )}
                              onCheckedChange={() =>
                                onWorkspaceFilterIdsChange(
                                  toggleStringValue(
                                    workspaceFilterIds,
                                    workspace.id
                                  )
                                )
                              }
                            />
                            <span
                              className="truncate"
                              title={`${workspace.name ?? workspace.branch} · ${workspace.branch}`}
                            >
                              {workspace.name ?? workspace.branch} ·{' '}
                              {workspace.branch}
                            </span>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {t('hubSidebar.codingAgent')}
                    </div>
                    <ScrollArea className="max-h-32">
                      <div className="space-y-2 pr-3">
                        {executorFilterOptions.map((executorOption) => (
                          <label
                            key={executorOption.value}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/40"
                          >
                            <Checkbox
                              checked={executorFilterValues.includes(
                                executorOption.value
                              )}
                              onCheckedChange={() =>
                                onExecutorFilterValuesChange(
                                  toggleStringValue(
                                    executorFilterValues,
                                    executorOption.value
                                  )
                                )
                              }
                            />
                            <span className="truncate">
                              {executorOption.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </PopoverContent>
              </Popover>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={cn(
                      SESSION_LIST_ACTION_BUTTON_CLASS,
                      'order-2 border border-border/60',
                      isArchiveView && 'text-foreground'
                    )}
                    aria-label={
                      isArchiveView
                        ? t('hubSidebar.backToSessionList')
                        : t('hubSidebar.openArchive')
                    }
                    onClick={() => onArchiveViewChange(!isArchiveView)}
                  >
                    <Archive className={SESSION_LIST_ACTION_ICON_CLASS} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isArchiveView
                    ? t('hubSidebar.backToSessionList')
                    : t('hubSidebar.openArchive')}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={cn(
                      SESSION_LIST_ACTION_BUTTON_CLASS,
                      'order-1',
                      isDeleteMode
                        ? 'text-destructive hover:text-destructive'
                        : undefined
                    )}
                    aria-label={
                      isDeleteMode
                        ? t('hubSidebar.exitDeleteMode')
                        : t('hubSidebar.bulkDelete')
                    }
                    onClick={onToggleDeleteMode}
                  >
                    <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isDeleteMode
                    ? t('hubSidebar.exitDeleteMode')
                    : t('hubSidebar.bulkDelete')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {isFlatListMode || (isWorkspaceListView && hasActiveFilters) ? (
            <div className="session-hub-drop-zone flex flex-wrap items-center gap-2 rounded-xl px-2.5 py-2 text-[11px] text-muted-foreground">
              {sortField && !isWorkspaceListView ? (
                <span className="session-hub-filter-chip rounded-full px-2 py-0.5">
                  {t('hubSidebar.sortChip', { label: getSortLabel(sortField) })}
                </span>
              ) : null}
              {workspaceFilterIds.length > 0 ? (
                <span className="session-hub-filter-chip rounded-full px-2 py-0.5">
                  {t('hubSidebar.workspaceChip', {
                    count: workspaceFilterIds.length,
                  })}
                </span>
              ) : null}
              {executorFilterValues.length > 0 ? (
                <span className="session-hub-filter-chip rounded-full px-2 py-0.5">
                  {t('hubSidebar.agentChip', {
                    count: executorFilterValues.length,
                  })}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto h-6 px-2 text-[11px]"
                onClick={onResetViewState}
              >
                {t('hubSidebar.restoreDefault')}
              </Button>
            </div>
          ) : null}

          {isDeleteMode ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px]">
              <span className="text-muted-foreground">
                {selectedSessionIdSet.size > 0
                  ? t('hubSidebar.selectedCount', {
                      count: selectedSessionIdSet.size,
                    })
                  : t('hubSidebar.selectSessionsToDelete')}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  disabled={
                    selectedSessionIdSet.size === 0 || isDeletingSessions
                  }
                  onClick={() => void onDeleteSelectedSessions()}
                >
                  {isDeletingSessions
                    ? t('hubSidebar.deleting')
                    : t('hubSidebar.deleteSelected')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={isDeletingSessions}
                  onClick={onCancelDeleteMode}
                >
                  {t('common:cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDragSessionId(null)}
        >
          <div
            className="session-hub-inset"
            data-expanded={insetExpanded ? 'true' : 'false'}
          >
            {showArchiveDrop ? (
              <ArchiveDropZone enabled={canDragToArchive} />
            ) : null}
            {visibleNotice ? (
              <SessionListNotice
                variant={visibleNotice.variant}
                onDismiss={() => setDismissedNotice(visibleNotice.message)}
              >
                {visibleNotice.message}
              </SessionListNotice>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 min-w-0 flex-1">
            {isWorkspaceListView ? (
              <div className="session-hub-list-body">
                {isLoading ? (
                  <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('hubSidebar.loadingSessions')}
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('hubSidebar.noSessions')}
                  </div>
                ) : workspaceListSessions.length > 0 ? (
                  <WorkspaceSessionList
                    sessions={workspaceListSessions}
                    isLoading={false}
                    activeSessionId={activeSessionId}
                    activeWorkspaceId={activeWorkspaceId}
                    onSessionClick={onSessionClick}
                    onPinSession={onPinSession}
                    onArchiveSession={(session) =>
                      onSessionStatusChange(session, ARCHIVED_SESSION_STATUS)
                    }
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
                    dndContextProvided
                    monitorPlacements={monitorPlacements}
                    currentExecutionPlacement={currentExecutionPlacement}
                  />
                ) : (
                  <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('hubSidebar.noFilterMatch')}
                  </div>
                )}
              </div>
            ) : (
              <div className="session-hub-list-body space-y-3">
                {isLoading ? (
                  <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('hubSidebar.loadingSessions')}
                  </div>
                ) : isArchiveView ? (
                  archivedSessions.length > 0 ? (
                    renderSessionList(
                      archivedSessions,
                      null,
                      false,
                      false,
                      selectedSessionIdSet,
                      monitorPlacements,
                      currentExecutionPlacement,
                      openingSessionId,
                      onSessionClick,
                      onToggleSessionSelection,
                      onRenameSession,
                      undefined,
                      onRestoreArchivedSession
                    )
                  ) : (
                    <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('hubSidebar.archiveEmpty')}
                    </div>
                  )
                ) : sessions.length === 0 ? (
                  <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('hubSidebar.noSessions')}
                  </div>
                ) : isFlatListMode ? (
                  flatSessions.length > 0 ? (
                    renderSessionList(
                      flatSessions,
                      null,
                      false,
                      isDeleteMode,
                      selectedSessionIdSet,
                      monitorPlacements,
                      currentExecutionPlacement,
                      openingSessionId,
                      onSessionClick,
                      onToggleSessionSelection,
                      onRenameSession,
                      onDeleteSession
                    )
                  ) : (
                    <div className="session-hub-drop-zone rounded-xl border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('hubSidebar.noFilterMatch')}
                    </div>
                  )
                ) : (
                  SESSION_STATUS_ORDER.map((status) => {
                    const sectionSessions = groupedSessions[status] ?? [];
                    const expanded = expandedSections[status] ?? true;

                    return (
                      <StatusDropZone
                        key={status}
                        status={status}
                        enabled={canDragAcrossSections}
                      >
                        <div className="space-y-2">
                          <SectionLabel
                            status={status}
                            title={SESSION_STATUS_LABELS[status]}
                            count={sectionSessions.length}
                            expanded={expanded}
                            onToggle={() => onExpandedChange(status, !expanded)}
                          />
                          {expanded && sectionSessions.length > 0
                            ? renderSessionList(
                                sectionSessions,
                                status,
                                canDragAcrossSections,
                                isDeleteMode,
                                selectedSessionIdSet,
                                monitorPlacements,
                                currentExecutionPlacement,
                                openingSessionId,
                                onSessionClick,
                                onToggleSessionSelection,
                                onRenameSession,
                                onDeleteSession
                              )
                            : null}
                        </div>
                      </StatusDropZone>
                    );
                  })
                )}
              </div>
            )}
          </ScrollArea>
        </DndContext>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        className="session-hub-resizer relative z-10 -ml-2 w-2 shrink-0 cursor-col-resize transition-colors before:absolute before:inset-y-0 before:right-0 before:w-px before:transition-[width,background-color] before:duration-150 hover:before:w-[3px]"
        onMouseDown={onResizeMouseDown}
      />
    </>
  );
}
