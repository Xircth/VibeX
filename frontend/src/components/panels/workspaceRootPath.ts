import type { RepoWithTargetBranch, Workspace } from 'shared/types';

type WorkspacePathSource = Pick<
  Workspace,
  'container_ref' | 'use_worktree' | 'agent_working_dir'
>;
type WorkspaceRepoPathSource = Pick<RepoWithTargetBranch, 'name'> & {
  path?: string | null;
};

function joinPath(base: string, child: string): string {
  const usesWindowsSeparator = base.includes('\\');
  const separator = usesWindowsSeparator ? '\\' : '/';
  const normalizedBase = base.replace(/[\\/]+$/, '');
  const normalizedChild = usesWindowsSeparator
    ? child.replaceAll('/', '\\').replace(/^\\+/, '')
    : child.replaceAll('\\', '/').replace(/^\/+/, '');

  return `${normalizedBase}${separator}${normalizedChild}`;
}

function splitPathSegments(path: string | null | undefined): string[] {
  return (path ?? '').split(/[\\/]+/).filter(Boolean);
}

function inferSingleRepoRootName(
  workspace: WorkspacePathSource,
  workspaceRepos: WorkspaceRepoPathSource[]
): string | null {
  if (!workspace.use_worktree) {
    return null;
  }

  if (workspaceRepos.length === 1) {
    const repoName = workspaceRepos[0]?.name?.trim();
    return repoName || null;
  }

  const agentWorkingDir = workspace.agent_working_dir?.trim();
  if (!agentWorkingDir) {
    return null;
  }

  const [firstSegment] = agentWorkingDir.split(/[\\/]+/).filter(Boolean);
  return firstSegment ?? null;
}

function resolveSingleRepoRootPath(
  workspace: WorkspacePathSource,
  workspaceRepos: WorkspaceRepoPathSource[]
): string | null {
  if (workspace.use_worktree || workspaceRepos.length !== 1) {
    return null;
  }

  const repoPath = workspaceRepos[0]?.path?.trim();
  return repoPath || null;
}

function containerAlreadyPointsAtRepoRoot(
  containerRef: string | null | undefined,
  repoRootName: string | null
): boolean {
  if (!containerRef || !repoRootName) {
    return false;
  }

  const normalizedContainer = containerRef.replace(/[\\/]+$/, '');
  const segments = normalizedContainer.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) === repoRootName;
}

function resolveSingleRepoWorktreeRootPath(
  workspace: WorkspacePathSource,
  workspaceRepos: WorkspaceRepoPathSource[],
  containerRef: string
): string | null {
  if (!workspace.use_worktree || workspaceRepos.length !== 1) {
    return null;
  }

  const repoRootName = inferSingleRepoRootName(workspace, workspaceRepos);
  if (!repoRootName) {
    return containerRef;
  }

  if (containerAlreadyPointsAtRepoRoot(containerRef, repoRootName)) {
    return containerRef;
  }

  const [firstWorkingDirSegment] = splitPathSegments(workspace.agent_working_dir);
  if (!firstWorkingDirSegment) {
    return containerRef;
  }

  return firstWorkingDirSegment === repoRootName
    ? joinPath(containerRef, repoRootName)
    : containerRef;
}

export function deriveWorkspaceRootPathCandidates(
  workspace: WorkspacePathSource | null | undefined,
  workspaceRepos: WorkspaceRepoPathSource[] = []
): string[] {
  const containerRef = workspace?.container_ref?.trim();
  if (!workspace || !containerRef) {
    return [];
  }

  const singleRepoRootPath = resolveSingleRepoRootPath(workspace, workspaceRepos);
  if (singleRepoRootPath) {
    return [...new Set([singleRepoRootPath, containerRef])];
  }

  const singleRepoWorktreeRootPath = resolveSingleRepoWorktreeRootPath(
    workspace,
    workspaceRepos,
    containerRef
  );
  if (singleRepoWorktreeRootPath) {
    const repoRootName = inferSingleRepoRootName(workspace, workspaceRepos);
    const repoNamedChild =
      repoRootName && !containerAlreadyPointsAtRepoRoot(containerRef, repoRootName)
        ? joinPath(containerRef, repoRootName)
        : null;
    return [
      ...new Set(
        [
          singleRepoWorktreeRootPath,
          containerRef,
          repoNamedChild,
        ].filter((value): value is string => Boolean(value))
      ),
    ];
  }

  const repoRootName = inferSingleRepoRootName(workspace, workspaceRepos);
  const candidates = [containerRef];

  if (
    repoRootName &&
    !containerAlreadyPointsAtRepoRoot(containerRef, repoRootName)
  ) {
    candidates.unshift(joinPath(containerRef, repoRootName));
  }

  return [...new Set(candidates)];
}

export function deriveWorkspaceRootPath(
  workspace: WorkspacePathSource | null | undefined,
  workspaceRepos: WorkspaceRepoPathSource[] = []
): string | null {
  return (
    deriveWorkspaceRootPathCandidates(workspace, workspaceRepos)[0] ?? null
  );
}
