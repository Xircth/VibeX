import { paths } from '@/lib/paths';

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
  rightSession,
  fallbackWorkspaceId,
  fallbackTaskId,
}: {
  projectId: string;
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

  if (!fallbackWorkspaceId) {
    return null;
  }

  return {
    workspaceId: fallbackWorkspaceId,
    taskId: fallbackTaskId ?? null,
    href: paths.projectWorkspace(projectId, fallbackWorkspaceId),
  };
}
