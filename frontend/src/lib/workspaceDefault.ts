import type { Workspace } from 'shared/types';

function normalizeBranch(branch: string | null | undefined): string | null {
  const value = branch?.trim().toLowerCase() ?? '';
  return value.length > 0 ? value : null;
}

export function resolveDefaultProjectWorkspace(input: {
  workspaces: readonly Workspace[];
  currentBranch?: string | null;
}): Workspace | null {
  const active = input.workspaces.filter((workspace) => !workspace.archived);
  if (active.length === 0) {
    return null;
  }

  const currentBranch = normalizeBranch(input.currentBranch);
  const projectRoots = active.filter((workspace) => !workspace.use_worktree);
  const onCurrent = (workspace: Workspace) =>
    currentBranch !== null &&
    normalizeBranch(workspace.branch) === currentBranch;

  return (
    projectRoots.find(onCurrent) ??
    projectRoots[0] ??
    active.find(onCurrent) ??
    active[0] ??
    null
  );
}
