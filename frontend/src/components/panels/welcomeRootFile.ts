import type { RepoWithTargetBranch, Workspace } from 'shared/types';
import { deriveWorkspaceRootPath } from './workspaceRootPath';

type WorkspacePathSource = Pick<
  Workspace,
  'container_ref' | 'use_worktree' | 'agent_working_dir'
>;
type WorkspaceRepoPathSource = Pick<RepoWithTargetBranch, 'name'> & {
  path?: string | null;
};

export function pickRandomProjectRootFile(
  files: readonly string[],
  gitignoredFiles: readonly string[] = [],
  random: () => number = Math.random
): string | null {
  const ignored = new Set(gitignoredFiles);
  const eligible = files.filter((file) => {
    if (ignored.has(file)) {
      return false;
    }
    if (/[/\\]/.test(file)) {
      return false;
    }
    return !file.startsWith('.');
  });

  if (eligible.length === 0) {
    return null;
  }

  const index = Math.min(
    eligible.length - 1,
    Math.max(0, Math.floor(random() * eligible.length))
  );
  return eligible[index] ?? null;
}

export function resolveWelcomeWorkspaceRootPath({
  storedRootPath,
  workspace,
  workspaceRepos,
  projectRepoPath,
}: {
  storedRootPath: string | null | undefined;
  workspace: WorkspacePathSource | null | undefined;
  workspaceRepos?: WorkspaceRepoPathSource[];
  projectRepoPath?: string | null;
}): string | null {
  const stored = storedRootPath?.trim();
  if (stored) {
    return stored;
  }

  return (
    deriveWorkspaceRootPath(workspace, workspaceRepos ?? []) ??
    projectRepoPath?.trim() ??
    null
  );
}
