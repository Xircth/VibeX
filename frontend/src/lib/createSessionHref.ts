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
