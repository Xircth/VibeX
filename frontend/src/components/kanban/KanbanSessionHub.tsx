import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Bot,
  ChevronDown,
  ChevronRight,
  ListFilter,
  PanelRightOpen,
  Plus,
  Rows2,
  Send,
  Trash2,
} from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';
import { useProject } from '@/contexts/ProjectContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import { useUserSystem } from '@/components/ConfigProvider';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { sessionsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { getFirstAvailableProfile } from '@/utils/executor';

const MONITOR_SLOT_STYLES = [
  {
    shell:
      'border-sky-200/90 bg-sky-100/60 dark:border-sky-400/20 dark:bg-sky-500/10',
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
    bar: 'bg-sky-400 dark:bg-sky-300',
  },
  {
    shell:
      'border-violet-200/90 bg-violet-100/60 dark:border-violet-400/20 dark:bg-violet-500/10',
    badge:
      'bg-violet-100 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
    bar: 'bg-violet-400 dark:bg-violet-300',
  },
  {
    shell:
      'border-emerald-200/90 bg-emerald-100/60 dark:border-emerald-400/20 dark:bg-emerald-500/10',
    badge:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    bar: 'bg-emerald-400 dark:bg-emerald-300',
  },
  {
    shell:
      'border-orange-200/90 bg-orange-100/60 dark:border-orange-400/20 dark:bg-orange-500/10',
    badge:
      'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300',
    bar: 'bg-orange-400 dark:bg-orange-300',
  },
] as const;

const RIGHT_PANEL_MARKER = {
  bar: 'bg-rose-400 dark:bg-rose-300',
} as const;

const INFO_TEXT_CLASS = 'text-sky-600 dark:text-sky-300';
const WORKSPACE_BADGE_CLASS =
  'inline-flex max-w-[120px] shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground';
const UNASSIGNED_EXECUTOR = '__kanban_unassigned_executor__';
const SESSION_LIST_ACTION_BUTTON_CLASS =
  'h-7 w-7 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground';
const SESSION_LIST_ACTION_ICON_CLASS = 'h-[11px] w-[11px]';

type SortField = 'name' | 'time' | 'status';

interface SessionMarker {
  bar: string;
}

function formatTimeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(Math.round(Math.abs(diffMs) / 1000), 1);
  const isFuture = diffMs < 0;
  const suffix = isFuture ? '后' : '前';

  if (seconds < 60) return '刚刚';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟${suffix}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天${suffix}`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月${suffix}`;

  return `${Math.round(months / 12)} 年${suffix}`;
}

function getSortLabel(sortField: SortField | null) {
  switch (sortField) {
    case 'name':
      return '名称';
    case 'time':
      return '时间';
    case 'status':
      return '状态';
    default:
      return '';
  }
}

function getExecutorFilterValue(executor: string | null) {
  return executor ?? UNASSIGNED_EXECUTOR;
}

function getExecutorDisplayName(executor: string | null) {
  if (!executor) return '未设置代理';
  return getAgentName(executor as ExecutorProfileId['executor']);
}

function mapSessionErrorMessage(error: unknown, fallback: string) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  if (message.includes('Workspace is required')) return '请选择工作区。';
  if (
    message.includes('会话仍在执行') ||
    message.includes('Process already running')
  ) {
    return '会话仍在执行，暂时无法删除。';
  }
  if (message.includes('Session') && message.includes('not found')) {
    return '会话不存在或已被删除。';
  }
  if (message.includes('Workspace') && message.includes('not found')) {
    return '工作区不存在。';
  }
  if (message.includes('Executor mismatch')) {
    return '当前会话绑定的代理与所选代理不一致。';
  }

  return fallback;
}

function sortSessions(
  sessions: KanbanProjectSessionRecord[],
  sortField: SortField | null
) {
  if (!sortField) return sessions;

  const next = [...sessions];
  next.sort((left, right) => {
    if (sortField === 'name') {
      return (
        left.fullName.localeCompare(right.fullName, 'zh-CN') ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    }

    if (sortField === 'status') {
      return (
        Number(left.isCompleted) - Number(right.isCompleted) ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    }

    return (
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
  });

  return next;
}

function toggleStringValue(values: string[], nextValue: string) {
  return values.includes(nextValue)
    ? values.filter((value) => value !== nextValue)
    : [...values, nextValue];
}

function truncateDisplayName(value: string, maxChars: number) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return value;
  }

  return `${chars.slice(0, maxChars).join('')}...`;
}

function getMonitorGridClassName(count: number) {
  if (count <= 2) {
    return 'grid-cols-2 grid-rows-1';
  }

  return 'grid-cols-2 grid-rows-2';
}

function getMonitorItemClassName(count: number, index: number) {
  if (count !== 3) {
    return '';
  }

  if (index === 0) {
    return 'col-start-1 row-start-1';
  }

  if (index === 1) {
    return 'col-start-1 row-start-2';
  }

  return 'col-start-2 row-start-1 row-span-2';
}

export function KanbanSessionHub() {
  const queryClient = useQueryClient();
  const { projectId } = useProject();
  const { profiles, config } = useUserSystem();
  const {
    visibleRightSession,
    monitorSessions,
    lastActiveWorkspaceId,
    canUseRightPanelForSessions,
    openSessionFromList,
    placeCreatedSession,
    promoteMonitorSession,
    pruneSessions,
  } = useKanbanSessionContext();
  const { sessions, sessionsById, workspaces, isLoading } =
    useKanbanProjectSessions(projectId);

  const defaultExecutorProfile = useMemo<ExecutorProfileId | null>(
    () => config?.executor_profile ?? getFirstAvailableProfile(profiles),
    [config?.executor_profile, profiles]
  );

  const defaultWorkspaceId = useMemo(() => {
    if (
      lastActiveWorkspaceId &&
      workspaces.some((workspace) => workspace.id === lastActiveWorkspaceId)
    ) {
      return lastActiveWorkspaceId;
    }

    return workspaces[0]?.id ?? '';
  }, [lastActiveWorkspaceId, workspaces]);

  const [createWorkspaceId, setCreateWorkspaceId] =
    useState(defaultWorkspaceId);
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [workspaceFilterIds, setWorkspaceFilterIds] = useState<string[]>([]);
  const [executorFilterValues, setExecutorFilterValues] = useState<string[]>(
    []
  );
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(
    null
  );
  const [deleteSuccessMessage, setDeleteSuccessMessage] = useState<
    string | null
  >(null);
  const [isDeletingSessions, setIsDeletingSessions] = useState(false);
  const [isInProgressExpanded, setIsInProgressExpanded] = useState(true);
  const [isCompletedExpanded, setIsCompletedExpanded] = useState(true);

  useEffect(() => {
    if (
      !createWorkspaceId ||
      !workspaces.some((workspace) => workspace.id === createWorkspaceId)
    ) {
      setCreateWorkspaceId(defaultWorkspaceId);
    }
  }, [createWorkspaceId, defaultWorkspaceId, workspaces]);

  useEffect(() => {
    setSelectedExecutorProfile((current) => current ?? defaultExecutorProfile);
  }, [defaultExecutorProfile]);

  useEffect(() => {
    pruneSessions(new Set(sessions.map((session) => session.id)));
  }, [pruneSessions, sessions]);

  useEffect(() => {
    const availableSessionIds = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((current) => {
      const next = current.filter((sessionId) =>
        availableSessionIds.has(sessionId)
      );
      return next.length === current.length ? current : next;
    });
  }, [sessions]);

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      if (!createWorkspaceId) {
        throw new Error('Workspace is required');
      }

      return sessionsApi.create({
        workspace_id: createWorkspaceId,
        executor: selectedExecutorProfile?.executor ?? undefined,
      });
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace_id],
      });
      placeCreatedSession({
        sessionId: session.id,
        workspaceId: session.workspace_id,
      });
      setIsCreateDialogOpen(false);
    },
  });

  const createExecutorOptions = useMemo(
    () =>
      profiles
        ? Object.keys(profiles)
            .sort((left, right) => left.localeCompare(right, 'zh-CN'))
            .map((executor) => ({
              value: executor,
              label: getAgentName(executor as ExecutorProfileId['executor']),
            }))
        : [],
    [profiles]
  );

  const executorFilterOptions = useMemo(() => {
    const values = Array.from(
      new Set(
        sessions.map((session) => getExecutorFilterValue(session.executor))
      )
    );

    return values
      .map((value) => ({
        value,
        label: getExecutorDisplayName(
          value === UNASSIGNED_EXECUTOR ? null : value
        ),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }, [sessions]);

  const hasActiveFilters =
    workspaceFilterIds.length > 0 || executorFilterValues.length > 0;
  const isFlatListMode = hasActiveFilters || sortField !== null;

  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) => {
        if (
          workspaceFilterIds.length > 0 &&
          !workspaceFilterIds.includes(session.workspace.id)
        ) {
          return false;
        }

        if (
          executorFilterValues.length > 0 &&
          !executorFilterValues.includes(
            getExecutorFilterValue(session.executor)
          )
        ) {
          return false;
        }

        return true;
      }),
    [executorFilterValues, sessions, workspaceFilterIds]
  );

  const flatSessions = useMemo(
    () => sortSessions(filteredSessions, sortField),
    [filteredSessions, sortField]
  );

  const inProgressSessions = useMemo(
    () => sessions.filter((session) => !session.isCompleted),
    [sessions]
  );
  const completedSessions = useMemo(
    () => sessions.filter((session) => session.isCompleted),
    [sessions]
  );

  const monitorRecords = useMemo(
    () =>
      monitorSessions
        .map((placement) => sessionsById[placement.sessionId])
        .filter((session): session is KanbanProjectSessionRecord =>
          Boolean(session)
        ),
    [monitorSessions, sessionsById]
  );

  const selectedSessionIdSet = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds]
  );

  const canCreateSession =
    !!createWorkspaceId &&
    !!selectedExecutorProfile?.executor &&
    !createSessionMutation.isPending;

  const monitorGridClassName = getMonitorGridClassName(monitorRecords.length);

  const displayedCount = isFlatListMode ? flatSessions.length : sessions.length;

  const handleCreateDialogOpenChange = (open: boolean) => {
    setIsCreateDialogOpen(open);

    if (open) {
      setCreateWorkspaceId(defaultWorkspaceId);
      setSelectedExecutorProfile(defaultExecutorProfile);
    }

    if (!open) {
      createSessionMutation.reset();
    }
  };

  const handleResetViewState = () => {
    setSortField(null);
    setWorkspaceFilterIds([]);
    setExecutorFilterValues([]);
  };

  const handleCancelDeleteMode = () => {
    setIsDeleteMode(false);
    setSelectedSessionIds([]);
    setDeleteErrorMessage(null);
  };

  const handleToggleDeleteMode = () => {
    if (isDeleteMode) {
      handleCancelDeleteMode();
      return;
    }

    setIsDeleteMode(true);
    setSelectedSessionIds([]);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);
  };

  const handleToggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds((current) => toggleStringValue(current, sessionId));
  };

  const handleSessionClick = (session: KanbanProjectSessionRecord) => {
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    if (isDeleteMode) {
      handleToggleSessionSelection(session.id);
      return;
    }

    openSessionFromList(session.placement);
  };

  const handleDeleteSelectedSessions = async () => {
    if (selectedSessionIds.length === 0 || isDeletingSessions) {
      return;
    }

    const result = await ConfirmDialog.show({
      title: '删除会话',
      message: `确定删除已选中的 ${selectedSessionIds.length} 个会话吗？正在执行中的会话不会被删除。`,
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingSessions(true);
    setDeleteErrorMessage(null);
    setDeleteSuccessMessage(null);

    const targetIds = [...selectedSessionIds];
    const targetSessions = targetIds
      .map((sessionId) => sessionsById[sessionId])
      .filter((session): session is KanbanProjectSessionRecord =>
        Boolean(session)
      );

    const deleteResults = await Promise.allSettled(
      targetIds.map(async (sessionId) => {
        await sessionsApi.delete(sessionId);
        return sessionId;
      })
    );

    const succeededIds = deleteResults
      .filter(
        (result): result is PromiseFulfilledResult<string> =>
          result.status === 'fulfilled'
      )
      .map((result) => result.value);

    const failedResults = deleteResults
      .map((result, index) => ({ result, sessionId: targetIds[index] }))
      .filter(
        (
          item
        ): item is {
          result: PromiseRejectedResult;
          sessionId: string;
        } => item.result.status === 'rejected'
      );

    const affectedWorkspaceIds = Array.from(
      new Set(targetSessions.map((session) => session.workspace.id))
    );

    await Promise.all(
      affectedWorkspaceIds.map((workspaceId) =>
        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        })
      )
    );

    succeededIds.forEach((sessionId) => {
      queryClient.removeQueries({
        queryKey: ['session', sessionId],
      });
    });

    if (succeededIds.length > 0) {
      const remainingSessionIds = new Set(
        sessions
          .map((session) => session.id)
          .filter((sessionId) => !succeededIds.includes(sessionId))
      );
      pruneSessions(remainingSessionIds);
      setDeleteSuccessMessage(`已删除 ${succeededIds.length} 个会话。`);
    }

    if (failedResults.length > 0) {
      setDeleteErrorMessage(
        failedResults
          .map(({ result }) =>
            mapSessionErrorMessage(result.reason, '删除失败，请稍后重试。')
          )
          .join('；')
      );
      setSelectedSessionIds(failedResults.map(({ sessionId }) => sessionId));
    } else {
      handleCancelDeleteMode();
    }

    setIsDeletingSessions(false);
  };

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex h-full min-h-0 bg-background">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border bg-muted/10">
          <div className="space-y-2.5 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-foreground">
                会话列表
              </div>

              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={SESSION_LIST_ACTION_BUTTON_CLASS}
                      aria-label="新增会话"
                      onClick={() => handleCreateDialogOpenChange(true)}
                    >
                      <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>新增会话</TooltipContent>
                </Tooltip>

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
                      aria-label="排序"
                    >
                      <ArrowUpDown className={SESSION_LIST_ACTION_ICON_CLASS} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={sortField ?? ''}
                      onValueChange={(value) =>
                        setSortField(value as SortField)
                      }
                    >
                      <DropdownMenuRadioItem value="name">
                        名称
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="time">
                        时间
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="status">
                        状态
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        SESSION_LIST_ACTION_BUTTON_CLASS,
                        hasActiveFilters && 'text-foreground'
                      )}
                      aria-label="筛选"
                    >
                      <ListFilter className={SESSION_LIST_ACTION_ICON_CLASS} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[280px] space-y-3 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-foreground">
                        筛选条件
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          setWorkspaceFilterIds([]);
                          setExecutorFilterValues([]);
                        }}
                      >
                        清空
                      </Button>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        工作区
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
                                  setWorkspaceFilterIds((current) =>
                                    toggleStringValue(current, workspace.id)
                                  )
                                }
                              />
                              <span className="truncate">
                                {workspace.branch}
                              </span>
                            </label>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        编程代理
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
                                  setExecutorFilterValues((current) =>
                                    toggleStringValue(
                                      current,
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
                        isDeleteMode
                          ? 'text-destructive hover:text-destructive'
                          : undefined
                      )}
                      aria-label={isDeleteMode ? '退出删除模式' : '批量删除'}
                      onClick={handleToggleDeleteMode}
                    >
                      <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isDeleteMode ? '退出删除模式' : '批量删除'}
                  </TooltipContent>
                </Tooltip>

                <div className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                  {displayedCount} / {sessions.length}
                </div>
              </div>
            </div>

            {isFlatListMode ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
                {sortField ? (
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    排序：{getSortLabel(sortField)}
                  </span>
                ) : null}
                {workspaceFilterIds.length > 0 ? (
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    工作区：{workspaceFilterIds.length}
                  </span>
                ) : null}
                {executorFilterValues.length > 0 ? (
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    代理：{executorFilterValues.length}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={handleResetViewState}
                >
                  恢复默认
                </Button>
              </div>
            ) : null}

            {isDeleteMode ? (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">
                    {selectedSessionIds.length > 0
                      ? `已选择 ${selectedSessionIds.length} 项`
                      : '请选择要删除的会话'}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      className="h-6 px-2 text-[11px]"
                      disabled={
                        selectedSessionIds.length === 0 || isDeletingSessions
                      }
                      onClick={handleDeleteSelectedSessions}
                    >
                      {isDeletingSessions ? '删除中...' : '删除选中'}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={isDeletingSessions}
                      onClick={handleCancelDeleteMode}
                    >
                      取消
                    </Button>
                  </div>
                </div>
                {deleteErrorMessage ? (
                  <p className="text-[11px] text-destructive">
                    {deleteErrorMessage}
                  </p>
                ) : null}
                {deleteSuccessMessage ? (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-300">
                    {deleteSuccessMessage}
                  </p>
                ) : null}
              </div>
            ) : deleteSuccessMessage ? (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-300">
                {deleteSuccessMessage}
              </p>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="px-3 py-3">
              {isLoading ? (
                <div className="rounded-xl border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
                  正在加载会话...
                </div>
              ) : sessions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
                  暂无会话。点击上方“新增”即可创建。
                </div>
              ) : isFlatListMode ? (
                flatSessions.length > 0 ? (
                  <div className="space-y-1.5">
                    {flatSessions.map((session) => (
                      <SessionListItem
                        key={session.id}
                        session={session}
                        marker={getSessionMarker(
                          session.id,
                          monitorSessions,
                          visibleRightSession
                        )}
                        isDeleteMode={isDeleteMode}
                        isSelected={selectedSessionIdSet.has(session.id)}
                        onClick={() => handleSessionClick(session)}
                        onToggleSelect={() =>
                          handleToggleSessionSelection(session.id)
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border bg-background px-4 py-6 text-center text-sm text-muted-foreground">
                    没有符合当前筛选或排序条件的会话。
                  </div>
                )
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <SectionLabel
                      title="进行中"
                      count={inProgressSessions.length}
                      expanded={isInProgressExpanded}
                      onToggle={() =>
                        setIsInProgressExpanded((current) => !current)
                      }
                    />
                    {isInProgressExpanded ? (
                      inProgressSessions.length > 0 ? (
                        <div className="space-y-1.5">
                          {inProgressSessions.map((session) => (
                            <SessionListItem
                              key={session.id}
                              session={session}
                              marker={getSessionMarker(
                                session.id,
                                monitorSessions,
                                visibleRightSession
                              )}
                              isDeleteMode={isDeleteMode}
                              isSelected={selectedSessionIdSet.has(session.id)}
                              onClick={() => handleSessionClick(session)}
                              onToggleSelect={() =>
                                handleToggleSessionSelection(session.id)
                              }
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                          暂无进行中的会话。
                        </div>
                      )
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    <SectionLabel
                      title="已完成"
                      count={completedSessions.length}
                      expanded={isCompletedExpanded}
                      onToggle={() =>
                        setIsCompletedExpanded((current) => !current)
                      }
                    />
                    {isCompletedExpanded ? (
                      completedSessions.length > 0 ? (
                        <div className="space-y-1.5">
                          {completedSessions.map((session) => (
                            <SessionListItem
                              key={session.id}
                              session={session}
                              marker={getSessionMarker(
                                session.id,
                                monitorSessions,
                                visibleRightSession
                              )}
                              isDeleteMode={isDeleteMode}
                              isSelected={selectedSessionIdSet.has(session.id)}
                              onClick={() => handleSessionClick(session)}
                              onToggleSelect={() =>
                                handleToggleSessionSelection(session.id)
                              }
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                          暂无已完成的会话。
                        </div>
                      )
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <div className="hidden">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Rows2 className="h-4 w-4" />
                会话监控区
              </div>
              <div className="text-xs text-muted-foreground">
                {canUseRightPanelForSessions
                  ? '左侧点击会话后，执行区优先占位，其余会话按顺序进入监控区。'
                  : '右侧栏当前已显示任务或已隐藏，会话仅能在监控区中查看。'}
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{monitorRecords.length} / 4 个监控位已占用</span>
              {visibleRightSession ? (
                <span className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-foreground">
                  执行区已占用
                </span>
              ) : (
                <span className="rounded-full border border-dashed border-border bg-background px-2 py-1 text-[11px]">
                  执行区空闲
                </span>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col p-4 pt-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Rows2 className="h-4 w-4" />
              <span>会话监控区</span>
              {monitorRecords.length > 0 ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {monitorRecords.length} / 4
                </span>
              ) : null}
            </div>
            {monitorRecords.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-muted/10 px-6 text-center text-sm text-muted-foreground">
                从左侧列表选择会话后，会在这里显示只读监控视图。
              </div>
            ) : (
              <div className={cn('grid min-h-0 flex-1 gap-4', monitorGridClassName)}>
                {monitorRecords.map((session, index) => (
                  <div
                    key={session.id}
                    className={cn(
                      'flex min-h-0 flex-col overflow-hidden rounded-2xl border p-3 shadow-sm',
                      MONITOR_SLOT_STYLES[index]?.shell,
                      getMonitorItemClassName(monitorRecords.length, index)
                    )}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex flex-1 items-center gap-2">
                        <div
                          className="truncate text-sm font-semibold text-foreground"
                          title={session.fullName}
                        >
                          {truncateDisplayName(session.fullName, 7)}
                        </div>
                        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                          {formatTimeAgo(session.updatedAt)}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                              aria-label="移入执行区"
                              disabled={!canUseRightPanelForSessions}
                              onClick={() => promoteMonitorSession(session.id)}
                            >
                              <PanelRightOpen className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>移入执行区</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>


                    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/50 bg-background/80">
                      <KanbanSessionConversationView
                        workspaceId={session.workspace.id}
                        sessionId={session.id}
                        className="h-full"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <Dialog
          open={isCreateDialogOpen}
          onOpenChange={handleCreateDialogOpenChange}
        >
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>新建会话</DialogTitle>
              <DialogDescription>
                选择归属工作区和编程代理。会话名称会在发送首条消息后自动生成。
              </DialogDescription>
            </DialogHeader>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                createSessionMutation.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="kanban-session-workspace">工作区</Label>
                <Select
                  value={createWorkspaceId || undefined}
                  onValueChange={setCreateWorkspaceId}
                >
                  <SelectTrigger
                    id="kanban-session-workspace"
                    className="h-9 text-sm"
                  >
                    <SelectValue placeholder="请选择工作区" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="kanban-session-agent">编程代理</Label>
                <Select
                  value={selectedExecutorProfile?.executor ?? undefined}
                  onValueChange={(value) =>
                    setSelectedExecutorProfile({
                      executor: value as ExecutorProfileId['executor'],
                      variant: null,
                    })
                  }
                >
                  <SelectTrigger
                    id="kanban-session-agent"
                    className="h-9 text-sm"
                  >
                    <SelectValue placeholder="请选择编程代理" />
                  </SelectTrigger>
                  <SelectContent>
                    {createExecutorOptions.map((executorOption) => (
                      <SelectItem
                        key={executorOption.value}
                        value={executorOption.value}
                      >
                        {executorOption.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {createSessionMutation.error ? (
                <p className="text-sm text-destructive">
                  {mapSessionErrorMessage(
                    createSessionMutation.error,
                    '创建会话失败，请稍后重试。'
                  )}
                </p>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleCreateDialogOpenChange(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={!canCreateSession}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {createSessionMutation.isPending ? '创建中...' : '创建会话'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function SectionLabel({
  title,
  count,
  expanded,
  onToggle,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
    >
      <div className="flex items-center gap-2">
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function SessionListItem({
  session,
  marker,
  isDeleteMode,
  isSelected,
  onClick,
  onToggleSelect,
}: {
  session: KanbanProjectSessionRecord;
  marker: SessionMarker | null;
  isDeleteMode: boolean;
  isSelected: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'relative flex items-start gap-1.5 overflow-hidden rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/40',
        isSelected && 'border-primary/40 bg-primary/5'
      )}
    >
      <div
        className={cn(
          'absolute inset-y-2 left-0 w-1 rounded-r-full bg-border',
          marker?.bar
        )}
      />

      {isDeleteMode ? (
        <div
          className="flex shrink-0 items-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
        </div>
      ) : null}

      <div className="min-w-0 flex-1 pl-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex flex-1 items-center gap-2">
            <div
              className="truncate text-sm font-semibold text-foreground"
              title={session.fullName}
            >
              {session.shortName}
            </div>
            <span className={cn(WORKSPACE_BADGE_CLASS, 'max-w-[96px] min-w-0')}>
              {session.branch}
            </span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {session.taskTitle ?? '\u672a\u5173\u8054\u4efb\u52a1'}
            </span>
          </div>
          <div
            className={cn('shrink-0 text-[11px] font-medium', INFO_TEXT_CLASS)}
          >
            {formatTimeAgo(session.updatedAt)}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex shrink-0 items-center justify-center text-muted-foreground">
                {session.executor ? (
                  <AgentIcon
                    agent={session.executor as ExecutorProfileId['executor']}
                    className="h-4 w-4"
                  />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {getExecutorDisplayName(session.executor)}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function getSessionMarker(
  sessionId: string,
  monitorSessions: Array<{ sessionId: string }>,
  rightSession: { sessionId: string } | null
): SessionMarker | null {
  if (rightSession?.sessionId === sessionId) {
    return { bar: RIGHT_PANEL_MARKER.bar };
  }

  const index = monitorSessions.findIndex(
    (session) => session.sessionId === sessionId
  );

  if (index < 0) {
    return null;
  }

  return { bar: MONITOR_SLOT_STYLES[index].bar };
}
