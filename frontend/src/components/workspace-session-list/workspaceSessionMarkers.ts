export type WorkspaceSessionMarkerTone = 'active' | 'related' | 'other';

export const WORKSPACE_SESSION_MARKER_CLASSES: Record<
  WorkspaceSessionMarkerTone,
  string
> = {
  active: 'bg-red-500',
  related: 'bg-primary',
  other: 'bg-muted-foreground/35',
};

function normalizeBranch(branch: string | null | undefined) {
  return (branch ?? '')
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
}

function branchesMatch(left: string, right: string) {
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  );
}

export function workspaceSessionMarkerTone({
  sessionId,
  workspaceId,
  branch,
  activeSessionId,
  activeWorkspaceId,
  activeBranch,
}: {
  sessionId: string;
  workspaceId: string;
  branch: string;
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  activeBranch: string | null | undefined;
}): WorkspaceSessionMarkerTone {
  if (sessionId === activeSessionId) return 'active';

  const currentBranch = normalizeBranch(activeBranch);
  const sessionBranch = normalizeBranch(branch);
  if (
    workspaceId === activeWorkspaceId ||
    (currentBranch.length > 0 &&
      sessionBranch.length > 0 &&
      branchesMatch(sessionBranch, currentBranch))
  ) {
    return 'related';
  }

  return 'other';
}
