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
import { dateTimestamp, formatRelativeTime } from '@/utils/date';

export const MONITOR_SLOT_STYLES = [
  {
    shell: 'kanban-usage-card',
    badge: 'session-status-done-count',
    bar: 'session-marker-primary',
  },
  {
    shell: 'kanban-usage-card',
    badge: 'session-status-inreview-count',
    bar: 'session-marker-warning',
  },
  {
    shell: 'kanban-usage-card',
    badge: 'session-status-inprogress-count',
    bar: 'session-marker-success',
  },
  {
    shell: 'kanban-usage-card',
    badge: 'session-status-todo-count',
    bar: 'session-marker-danger',
  },
] as const;

export const RIGHT_PANEL_MARKER = {
  bar: 'session-marker-primary',
  badge: 'session-status-inreview-count',
} as const;

export const INFO_TEXT_CLASS = 'text-primary';
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
    todo: 'hsl(var(--destructive))',
    inprogress: 'hsl(var(--success))',
    inreview: 'hsl(var(--warning))',
    done: 'var(--text-muted)',
  };
export const SESSION_STATUS_SECTION_STYLES: Record<
  ActiveSessionStatus,
  { text: string; pill: string; count: string }
> = {
  todo: {
    text: 'session-status-todo-text',
    pill: 'session-status-todo-pill',
    count: 'session-status-todo-count',
  },
  inprogress: {
    text: 'session-status-inprogress-text',
    pill: 'session-status-inprogress-pill',
    count: 'session-status-inprogress-count',
  },
  inreview: {
    text: 'session-status-inreview-text',
    pill: 'session-status-inreview-pill',
    count: 'session-status-inreview-count',
  },
  done: {
    text: 'session-status-done-text',
    pill: 'session-status-done-pill',
    count: 'session-status-done-count',
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

/**
 * Relative time for session timestamps. Delegates to the canonical Chinese
 * implementation in `@/utils/date` (single source of truth).
 */
export function formatTimeAgo(iso: string) {
  return formatRelativeTime(iso);
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
