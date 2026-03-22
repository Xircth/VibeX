import type { RepoWithTargetBranch, Workspace } from 'shared/types';

type WorkspacePathSource = Pick<Workspace, 'container_ref' | 'use_worktree'>;
type WorkspaceRepoPathSource = Pick<RepoWithTargetBranch, 'name'>;

export function deriveWorkspaceRootPath(
  workspace: WorkspacePathSource | null | undefined,
  workspaceRepos: WorkspaceRepoPathSource[] = []
): string | null {
  const containerRef = workspace?.container_ref;
  if (!containerRef) {
    return null;
  }

  if (!workspace.use_worktree || workspaceRepos.length === 0) {
    return containerRef;
  }

  const separator = containerRef.includes('\\') ? '\\' : '/';
  return `${containerRef.replace(/[\\/]+$/, '')}${separator}${workspaceRepos[0].name}`;
}
