import type { RepoWithTargetBranch, Workspace } from 'shared/types';

type WorkspacePathSource = Pick<
  Workspace,
  'container_ref' | 'use_worktree' | 'agent_working_dir'
>;
type WorkspaceRepoPathSource = Pick<RepoWithTargetBranch, 'name'>;

export function deriveWorkspaceRootPathCandidates(
  workspace: WorkspacePathSource | null | undefined,
  _workspaceRepos: WorkspaceRepoPathSource[] = []
): string[] {
  const containerRef = workspace?.container_ref?.trim();
  if (!workspace || !containerRef) {
    return [];
  }

  return [containerRef];
}

export function deriveWorkspaceRootPath(
  workspace: WorkspacePathSource | null | undefined,
  workspaceRepos: WorkspaceRepoPathSource[] = []
): string | null {
  return (
    deriveWorkspaceRootPathCandidates(workspace, workspaceRepos)[0] ?? null
  );
}
