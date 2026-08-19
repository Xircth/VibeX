import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { dateTimestamp } from '@/utils/date';

export const WORKSPACE_SESSION_GROUPS_COLLAPSED_KEY =
  'vibex-workspace-session-groups-collapsed';
export const WORKSPACE_SESSION_ORDER_KEY = 'vibex-workspace-session-order';

export type WorkspaceSessionStatusTone =
  | 'todo'
  | 'inprogress'
  | 'inreview'
  | 'done';

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
    group.sessions = applyWorkspaceSessionOrder(
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
}): WorkspaceSessionStatusTone {
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
    return [...sessions].sort(comparePinnedThenRecent);
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const placed = new Set<string>();
  const ordered: KanbanProjectSessionRecord[] = [];

  sessions
    .filter((session) => !savedOrder.includes(session.id))
    .sort(comparePinnedThenRecent)
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

function comparePinnedThenRecent(
  left: KanbanProjectSessionRecord,
  right: KanbanProjectSessionRecord
) {
  const leftPinned = Boolean(left.pinnedAt);
  const rightPinned = Boolean(right.pinnedAt);
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  return dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt);
}

function latestSessionTimestamp(group: WorkspaceSessionGroup): number {
  return group.sessions.reduce((latest, session) => {
    const timestamp = dateTimestamp(session.updatedAt);
    return timestamp > latest ? timestamp : latest;
  }, 0);
}
