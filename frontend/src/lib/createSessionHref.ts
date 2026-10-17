import {
  parseProjectSessionRoute,
  parseProjectWorkspaceRoute,
  paths,
  splitRouteParts,
} from '@/lib/paths';

export function preserveCreateSessionQuery(
  href: string,
  searchParams: URLSearchParams
): string {
  if (
    searchParams.get('newSession') !== '1' &&
    searchParams.get('createSession') !== '1'
  ) {
    return href;
  }

  const { pathname, search, hash } = splitRouteParts(href);
  const nextSearchParams = new URLSearchParams(search);
  nextSearchParams.set('newSession', '1');
  const nextSearch = nextSearchParams.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}

export function resolveCreateSessionHref({
  projectId,
  isWorkspaceTab,
  workspaceId,
  activeWorktreeId,
  rightSessionWorkspaceId,
}: {
  projectId: string;
  isWorkspaceTab: boolean;
  workspaceId?: string | null;
  activeWorktreeId?: string | null;
  rightSessionWorkspaceId?: string | null;
}): string {
  if (isWorkspaceTab) {
    const targetWorkspaceId =
      workspaceId ?? activeWorktreeId ?? rightSessionWorkspaceId;
    if (targetWorkspaceId) {
      return `${paths.projectWorkspace(projectId, targetWorkspaceId)}?newSession=1`;
    }
  }

  return `${paths.projectSessions(projectId)}?newSession=1`;
}

export function resolveWorkspaceTabNavigation({
  projectId,
  lastRoute,
  rightSession,
  fallbackWorkspaceId,
  fallbackTaskId,
}: {
  projectId: string;
  lastRoute?: string | null;
  rightSession?: {
    workspaceId: string;
    sessionId: string;
  } | null;
  fallbackWorkspaceId?: string | null;
  fallbackTaskId?: string | null;
}): {
  workspaceId: string;
  taskId: string | null;
  href: string;
} | null {
  const lastSession = lastRoute ? parseProjectSessionRoute(lastRoute) : null;
  if (lastSession && lastSession.projectId === projectId) {
    return {
      workspaceId: lastSession.workspaceId,
      taskId: null,
      href: paths.projectSession(
        projectId,
        lastSession.workspaceId,
        lastSession.sessionId
      ),
    };
  }

  if (rightSession) {
    return {
      workspaceId: rightSession.workspaceId,
      taskId: null,
      href: paths.projectSession(
        projectId,
        rightSession.workspaceId,
        rightSession.sessionId
      ),
    };
  }

  const lastWorkspace = lastRoute
    ? parseProjectWorkspaceRoute(lastRoute)
    : null;
  if (lastWorkspace && lastWorkspace.projectId === projectId) {
    return {
      workspaceId: lastWorkspace.workspaceId,
      taskId: null,
      href: paths.projectWorkspace(projectId, lastWorkspace.workspaceId),
    };
  }

  if (!fallbackWorkspaceId) {
    return null;
  }

  return {
    workspaceId: fallbackWorkspaceId,
    taskId: fallbackTaskId ?? null,
    href: paths.projectWorkspace(projectId, fallbackWorkspaceId),
  };
}
