import type { ExecutorProfileId } from 'shared/types';
import { getAgentName } from '@/components/agents/AgentIcon';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { dateTimestamp } from '@/utils/date';

export const WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY =
  'vibex-workspace-session-groups-collapsed';
export const WORKSPACE_SESSION_ORDER_KEY = 'vibex-workspace-session-order';
export const PINNED_SESSION_GROUP_ID = '__pinned__';

export type WorkspaceSessionStatusTone =
  | 'todo'
  | 'inprogress'
  | 'inreview'
  | 'done';

export type SessionListSortKey = 'name' | 'time' | 'agent';

export type SessionListSortSpec = {
  key: SessionListSortKey;
  direction: 'asc' | 'desc';
};

export interface WorkspaceSessionGroup {
  workspaceId: string;
  label: string;
  branch: string;
  useWorktree: boolean;
  pinned: boolean;
  sessions: KanbanProjectSessionRecord[];
}

export function workspaceGroupLabel(
  session: KanbanProjectSessionRecord
): string {
  if (session.workspace.use_worktree) {
    const named = session.workspaceName.trim();
    return named || session.branch;
  }

  return session.branch || session.workspaceName;
}

export function groupWorkspaceSessions(
  sessions: KanbanProjectSessionRecord[],
  options: {
    activeWorkspaceId?: string | null;
    sessionOrderByWorkspace?: Record<string, string[]>;
    sortSpecs?: SessionListSortSpec[];
  } = {}
): WorkspaceSessionGroup[] {
  const groups = new Map<string, WorkspaceSessionGroup>();
  const sessionOrderByWorkspace = options.sessionOrderByWorkspace ?? {};

  sessions.forEach((session) => {
    const workspaceId = session.workspace.id;
    const existing = groups.get(workspaceId);
    if (existing) {
      existing.sessions.push(session);
      return;
    }

    groups.set(workspaceId, {
      workspaceId,
      label: workspaceGroupLabel(session),
      branch: session.branch,
      useWorktree: session.workspace.use_worktree,
      pinned: session.workspace.pinned,
      sessions: [session],
    });
  });

  groups.forEach((group) => {
    group.sessions =
      options.sortSpecs && options.sortSpecs.length > 0
        ? sortWorkspaceSessions(group.sessions, options.sortSpecs)
        : applyWorkspaceSessionOrder(
            group.sessions,
            sessionOrderByWorkspace[group.workspaceId]
          );
  });

  const activeWorkspaceId = options.activeWorkspaceId ?? null;

  return [...groups.values()].sort((left, right) => {
    if (activeWorkspaceId) {
      if (left.workspaceId === activeWorkspaceId) return -1;
      if (right.workspaceId === activeWorkspaceId) return 1;
    }

    return latestSessionTimestamp(right) - latestSessionTimestamp(left);
  });
}

export function sessionListTitle(session: KanbanProjectSessionRecord): string {
  const manualName = session.name?.trim();
  if (manualName) return manualName;

  const prompt = session.firstPrompt?.replace(/\s+/g, ' ').trim();
  if (prompt) return prompt;

  return session.fullName;
}

export function workspaceSessionStatusTone(session: {
  status: string;
  isRunning?: boolean;
}): WorkspaceSessionStatusTone {
  if (session.isRunning) {
    return 'inprogress';
  }

  switch (session.status) {
    case 'inprogress':
      return 'inprogress';
    case 'inreview':
      return 'inreview';
    case 'done':
    case 'archived':
      return 'done';
    default:
      return 'todo';
  }
}

export function applyWorkspaceSessionOrder(
  sessions: KanbanProjectSessionRecord[],
  savedOrder?: string[]
): KanbanProjectSessionRecord[] {
  if (!savedOrder || savedOrder.length === 0) {
    return [...sessions].sort(compareSessionsByRecency);
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const placed = new Set<string>();
  const ordered: KanbanProjectSessionRecord[] = [];

  sessions
    .filter((session) => !savedOrder.includes(session.id))
    .sort(compareSessionsByRecency)
    .forEach((session) => {
      ordered.push(session);
      placed.add(session.id);
    });

  savedOrder.forEach((sessionId) => {
    const session = byId.get(sessionId);
    if (!session || placed.has(sessionId)) return;
    ordered.push(session);
    placed.add(sessionId);
  });

  return ordered;
}

export function moveSessionInOrder(
  sessionIds: string[],
  activeId: string,
  overId: string
): string[] | null {
  const from = sessionIds.indexOf(activeId);
  const to = sessionIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = sessionIds.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function readWorkspaceSessionOrders(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): Record<string, string[]> {
  try {
    const raw = storage.getItem(WORKSPACE_SESSION_ORDER_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) &&
          entry[1].every((value) => typeof value === 'string')
      )
    );
  } catch {
    return {};
  }
}

export function writeWorkspaceSessionOrders(
  orders: Record<string, string[]>,
  storage: Pick<Storage, 'setItem'> = window.localStorage
) {
  storage.setItem(WORKSPACE_SESSION_ORDER_KEY, JSON.stringify(orders));
}

export function formatCompactSessionAge(
  value: string | number | Date,
  now = Date.now()
): string {
  const diffMs = Math.max(now - dateTimestamp(value), 0);
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return 'now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;

  return `${Math.max(1, Math.round(days / 30))}mo`;
}

export function readCollapsedWorkspaceIds(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): string[] {
  try {
    const raw = storage.getItem(WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

export function writeCollapsedWorkspaceIds(
  ids: Iterable<string>,
  storage: Pick<Storage, 'setItem'> = window.localStorage
) {
  storage.setItem(
    WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY,
    JSON.stringify([...ids])
  );
}

export function pinnedWorkspaceSessions(
  sessions: KanbanProjectSessionRecord[],
  sortSpecs?: SessionListSortSpec[]
): KanbanProjectSessionRecord[] {
  const pinned = sessions.filter((session) => Boolean(session.pinnedAt));
  if (sortSpecs && sortSpecs.length > 0) {
    return sortWorkspaceSessions(pinned, sortSpecs);
  }

  return pinned.sort((left, right) => {
    const pinDelta =
      dateTimestamp(right.pinnedAt ?? 0) - dateTimestamp(left.pinnedAt ?? 0);
    if (pinDelta !== 0) {
      return pinDelta;
    }
    return compareSessionsByRecency(left, right);
  });
}

export function sessionAgentLabel(session: KanbanProjectSessionRecord): string {
  const agentKey = session.agentId || session.executor;
  if (!agentKey) {
    return '';
  }
  return getAgentName(agentKey as ExecutorProfileId['executor']);
}

export function sessionMatchesQuery(
  session: KanbanProjectSessionRecord,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    sessionListTitle(session),
    session.fullName,
    session.shortName,
    session.name,
    session.firstPrompt,
  ].some((value) => value?.toLowerCase().includes(needle));
}

export function defaultSessionListSortDirection(
  key: SessionListSortKey
): 'asc' | 'desc' {
  return key === 'time' ? 'desc' : 'asc';
}

export function toggleSessionListSort(
  current: SessionListSortSpec[],
  key: SessionListSortKey
): SessionListSortSpec[] {
  const last = current[current.length - 1];
  if (last?.key === key) {
    return [
      ...current.slice(0, -1),
      {
        key,
        direction: last.direction === 'asc' ? 'desc' : 'asc',
      },
    ];
  }

  return [
    ...current.filter((spec) => spec.key !== key),
    { key, direction: defaultSessionListSortDirection(key) },
  ];
}

export function sortWorkspaceSessions(
  sessions: KanbanProjectSessionRecord[],
  sortSpecs: SessionListSortSpec[]
): KanbanProjectSessionRecord[] {
  if (sortSpecs.length === 0) {
    return [...sessions];
  }

  return [...sessions].sort((left, right) => {
    for (let index = sortSpecs.length - 1; index >= 0; index -= 1) {
      const spec = sortSpecs[index];
      if (!spec) continue;
      const delta = compareSessionsBySortKey(left, right, spec);
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  });
}

function compareSessionsBySortKey(
  left: KanbanProjectSessionRecord,
  right: KanbanProjectSessionRecord,
  spec: SessionListSortSpec
): number {
  const direction = spec.direction === 'desc' ? -1 : 1;
  switch (spec.key) {
    case 'name':
      return (
        sessionListTitle(left).localeCompare(
          sessionListTitle(right),
          undefined,
          { sensitivity: 'base' }
        ) * direction
      );
    case 'agent':
      return (
        sessionAgentLabel(left).localeCompare(
          sessionAgentLabel(right),
          undefined,
          { sensitivity: 'base' }
        ) * direction
      );
    case 'time':
      return (
        (dateTimestamp(left.updatedAt) - dateTimestamp(right.updatedAt)) *
        direction
      );
  }
}

function compareSessionsByRecency(
  left: KanbanProjectSessionRecord,
  right: KanbanProjectSessionRecord
) {
  return dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt);
}

function latestSessionTimestamp(group: WorkspaceSessionGroup): number {
  return group.sessions.reduce((latest, session) => {
    const timestamp = dateTimestamp(session.updatedAt);
    return timestamp > latest ? timestamp : latest;
  }, 0);
}
