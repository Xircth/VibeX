import type { ExecutorProfileId } from 'shared/types';
import type { SessionStatus } from '@/lib/api';
import { getAgentName } from '@/components/agents/AgentIcon';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import {
  findWorkspaceBranchOption,
  resolveWorkspaceBranchSelection,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';
import { dateTimestamp } from '@/utils/date';

export const MONITOR_SLOT_STYLES = [
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

export const RIGHT_PANEL_MARKER = {
  bar: 'bg-rose-400 dark:bg-rose-300',
  badge: 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
} as const;

export const INFO_TEXT_CLASS = 'text-sky-600 dark:text-sky-300';
export const UNASSIGNED_EXECUTOR = '__kanban_unassigned_executor__';
export const SESSION_LIST_ACTION_BUTTON_CLASS =
  'session-hub-action-button h-7 w-7 p-0 shadow-none';
export const SESSION_LIST_ACTION_ICON_CLASS = 'h-[11px] w-[11px]';
export const SESSION_LIST_WIDTH_STORAGE_KEY = 'vibex-kanban-session-list-width';
export const DEFAULT_SESSION_LIST_WIDTH = 320;
export const MIN_SESSION_LIST_WIDTH = 280;
export const MAX_SESSION_LIST_WIDTH = 560;
export type ActiveSessionStatus = Exclude<SessionStatus, 'archived'>;
export const ARCHIVED_SESSION_STATUS: SessionStatus = 'archived';
export const SESSION_STATUS_ORDER: ActiveSessionStatus[] = [
  'todo',
  'inprogress',
  'inreview',
  'done',
];
export const SESSION_STATUS_LABELS: Record<ActiveSessionStatus, string> = {
  todo: '待开始',
  inprogress: '进行中',
  inreview: '待检查',
  done: '已完成',
};
export const SESSION_STATUS_LIGHT_COLORS: Record<ActiveSessionStatus, string> =
  {
    todo: '#EF4444',
    inprogress: '#22C55E',
    inreview: '#EAB308',
    done: '#9CA3AF',
  };
export const SESSION_STATUS_SECTION_STYLES: Record<
  ActiveSessionStatus,
  { text: string; pill: string; count: string }
> = {
  todo: {
    text: 'text-rose-600 dark:text-rose-300',
    pill: 'border-rose-500/30 bg-rose-500/10',
    count: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200',
  },
  inprogress: {
    text: 'text-emerald-600 dark:text-emerald-300',
    pill: 'border-emerald-500/30 bg-emerald-500/10',
    count:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
  },
  inreview: {
    text: 'text-amber-600 dark:text-amber-300',
    pill: 'border-amber-500/30 bg-amber-500/10',
    count:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200',
  },
  done: {
    text: 'text-slate-600 dark:text-slate-300',
    pill: 'border-slate-500/30 bg-slate-500/10',
    count:
      'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-200',
  },
};

export type SortField = 'name' | 'time' | 'status';
export type KanbanSessionCreationMode =
  | 'existing_workspace'
  | 'new_workspace';

export interface SessionMarker {
  bar: string;
  badge?: string;
  label?: string;
}

function getSessionStatusOrder(status: SessionStatus) {
  if (status === ARCHIVED_SESSION_STATUS) {
    return SESSION_STATUS_ORDER.length;
  }

  return SESSION_STATUS_ORDER.indexOf(status as ActiveSessionStatus);
}

export function formatTimeAgo(iso: string) {
  const diffMs = Date.now() - dateTimestamp(iso);
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

export function getSortLabel(sortField: SortField | null) {
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

export function getExecutorFilterValue(executor: string | null) {
  return executor ?? UNASSIGNED_EXECUTOR;
}

export function getExecutorDisplayName(executor: string | null) {
  if (!executor) return '未设置代理';
  return getAgentName(executor as ExecutorProfileId['executor']);
}

export function mapSessionErrorMessage(error: unknown, fallback: string) {
  return getSessionUiErrorMessage(error, fallback);
}

export function sortSessions(
  sessions: KanbanProjectSessionRecord[],
  sortField: SortField | null
) {
  if (!sortField) return sessions;

  const next = [...sessions];
  next.sort((left, right) => {
    if (sortField === 'name') {
      return (
        left.fullName.localeCompare(right.fullName, 'zh-CN') ||
        dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt)
      );
    }

    if (sortField === 'status') {
      return (
        getSessionStatusOrder(left.status) -
          getSessionStatusOrder(right.status) ||
        dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt)
      );
    }

    return dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt);
  });

  return next;
}

export function toggleStringValue(values: string[], nextValue: string) {
  return values.includes(nextValue)
    ? values.filter((value) => value !== nextValue)
    : [...values, nextValue];
}

export interface ExecutorFilterOption {
  value: string;
  label: string;
}

export function getExecutorFilterOptions(
  sessions: KanbanProjectSessionRecord[]
): ExecutorFilterOption[] {
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
}

export function filterKanbanSessions({
  sessions,
  workspaceFilterIds,
  executorFilterValues,
}: {
  sessions: KanbanProjectSessionRecord[];
  workspaceFilterIds: string[];
  executorFilterValues: string[];
}): KanbanProjectSessionRecord[] {
  return sessions.filter((session) => {
    if (
      workspaceFilterIds.length > 0 &&
      !workspaceFilterIds.includes(session.workspace.id)
    ) {
      return false;
    }

    if (
      executorFilterValues.length > 0 &&
      !executorFilterValues.includes(getExecutorFilterValue(session.executor))
    ) {
      return false;
    }

    return true;
  });
}

export function groupKanbanSessionsByStatus(
  sessions: KanbanProjectSessionRecord[]
): Record<ActiveSessionStatus, KanbanProjectSessionRecord[]> {
  const groups: Record<ActiveSessionStatus, KanbanProjectSessionRecord[]> = {
    todo: [],
    inprogress: [],
    inreview: [],
    done: [],
  };

  sessions.forEach((session) => {
    groups[session.status as ActiveSessionStatus].push(session);
  });

  return groups;
}

export function getDisplayedSessionCount({
  workspaceFilterIds,
  executorFilterValues,
  sortField,
  filteredCount,
  activeCount,
}: {
  workspaceFilterIds: string[];
  executorFilterValues: string[];
  sortField: SortField | null;
  filteredCount: number;
  activeCount: number;
}): number {
  return workspaceFilterIds.length > 0 ||
    executorFilterValues.length > 0 ||
    sortField !== null
    ? filteredCount
    : activeCount;
}

export interface CreateProjectSessionRequest {
  project_id: string;
  workspace_id: string | null;
  branch: string | null;
  executor?: string;
  name: string | null;
  create_workspace: boolean;
  repos?: Array<{ repo_id: string; target_branch: string }>;
}

export function getCanCreateKanbanSession({
  executorProfile,
  isPending,
  mode,
  selectedWorkspaceOption,
  projectRepoCount,
  repoBranchConfigs,
}: {
  executorProfile: ExecutorProfileId | null;
  isPending: boolean;
  mode: KanbanSessionCreationMode;
  selectedWorkspaceOption: WorkspaceBranchOption | null;
  projectRepoCount: number;
  repoBranchConfigs: Array<{ targetBranch?: string | null } & Record<
    string,
    unknown
  >>;
}): boolean {
  if (!executorProfile?.executor || isPending) {
    return false;
  }

  if (mode === 'existing_workspace') {
    return Boolean(selectedWorkspaceOption);
  }

  return (
    projectRepoCount > 0 &&
    repoBranchConfigs.length > 0 &&
    repoBranchConfigs.every((config) => Boolean(config.targetBranch))
  );
}

export function getCreateProjectSessionRequest({
  projectId,
  workspaceValue,
  sessionName,
  executorProfile,
  mode,
  workspaceBranchOptions,
  repoInputs,
}: {
  projectId: string | null | undefined;
  workspaceValue: string;
  sessionName: string;
  executorProfile: ExecutorProfileId | null;
  mode: KanbanSessionCreationMode;
  workspaceBranchOptions: WorkspaceBranchOption[];
  repoInputs?: Array<{ repo_id: string; target_branch: string }>;
}): CreateProjectSessionRequest {
  if (mode === 'existing_workspace' && !workspaceValue) {
    throw new Error('Workspace is required');
  }

  if (!projectId) {
    throw new Error('Project is required');
  }

  const selectedWorkspaceOption =
    mode === 'existing_workspace'
      ? findWorkspaceBranchOption(workspaceBranchOptions, workspaceValue)
      : null;
  const workspaceSelection =
    mode === 'existing_workspace'
      ? resolveWorkspaceBranchSelection(selectedWorkspaceOption)
      : { workspaceId: null, branch: null };

  return {
    project_id: projectId,
    workspace_id: workspaceSelection.workspaceId,
    branch: workspaceSelection.branch,
    executor: executorProfile?.executor ?? undefined,
    name: sessionName.trim() || null,
    create_workspace: mode === 'new_workspace',
    repos: mode === 'new_workspace' ? repoInputs : undefined,
  };
}

export interface BulkDeleteSessionSummary {
  succeededIds: string[];
  failedResults: Array<{
    result: PromiseRejectedResult;
    sessionId: string;
  }>;
  failedSessionIds: string[];
  affectedWorkspaceIds: string[];
  remainingSessionIds: Set<string>;
}

export function getBulkDeleteSessionSummary({
  targetIds,
  sessionsById,
  sessions,
  deleteResults,
}: {
  targetIds: string[];
  sessionsById: Record<string, KanbanProjectSessionRecord | undefined>;
  sessions: KanbanProjectSessionRecord[];
  deleteResults: PromiseSettledResult<string>[];
}): BulkDeleteSessionSummary {
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

  const targetSessions = targetIds
    .map((sessionId) => sessionsById[sessionId])
    .filter((session): session is KanbanProjectSessionRecord =>
      Boolean(session)
    );
  const succeededIdSet = new Set(succeededIds);

  return {
    succeededIds,
    failedResults,
    failedSessionIds: failedResults.map(({ sessionId }) => sessionId),
    affectedWorkspaceIds: Array.from(
      new Set(targetSessions.map((session) => session.workspace.id))
    ),
    remainingSessionIds: new Set(
      sessions
        .map((session) => session.id)
        .filter((sessionId) => !succeededIdSet.has(sessionId))
    ),
  };
}

export function getMonitorGridClassName(count: number) {
  if (count <= 2) {
    return 'grid-cols-2 grid-rows-1';
  }

  return 'grid-cols-2 grid-rows-2';
}

export function getMonitorItemClassName(count: number, index: number) {
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

export function getSessionMarker(
  sessionId: string,
  monitorSessions: Array<{ sessionId: string }>,
  rightSession: { sessionId: string } | null
): SessionMarker | null {
  if (rightSession?.sessionId === sessionId) {
    return {
      bar: RIGHT_PANEL_MARKER.bar,
      badge: RIGHT_PANEL_MARKER.badge,
    };
  }

  const index = monitorSessions.findIndex(
    (session) => session.sessionId === sessionId
  );

  if (index < 0) {
    return null;
  }

  return { bar: MONITOR_SLOT_STYLES[index].bar };
}
