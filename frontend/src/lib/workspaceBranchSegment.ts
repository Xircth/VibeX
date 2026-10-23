import type { GitBranch } from 'shared/types';

export type BranchSegmentRole = 'main-directory' | 'current' | 'available';

export interface BranchSegmentEntry {
  name: string;
  role: BranchSegmentRole;
  /** Present when choosing this row opens a workspace instead of checking out. */
  workspaceId: string | null;
}

function normalizeBranch(branch: string | null | undefined): string {
  return branch?.trim().toLowerCase() ?? '';
}

function sameBranch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeBranch(left);
  const normalizedRight = normalizeBranch(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function orderWorkspacesForSelector<T extends { use_worktree: boolean }>(
  workspaces: readonly T[]
): T[] {
  const roots: T[] = [];
  const worktrees: T[] = [];
  for (const workspace of workspaces) {
    if (workspace.use_worktree) {
      worktrees.push(workspace);
    } else {
      roots.push(workspace);
    }
  }
  return [...roots, ...worktrees];
}

/**
 * Branches the selector can act on for the directory the user is in.
 * A worktree list leads with the main directory's current branch so that
 * checkout target stays visible after leaving the project root.
 */
export function buildBranchSegment({
  branches,
  inWorktree,
  currentDirectoryBranch,
  mainDirectoryBranch,
  projectRootWorkspaceId,
}: {
  branches: readonly GitBranch[];
  inWorktree: boolean;
  currentDirectoryBranch: string | null;
  mainDirectoryBranch: string | null;
  projectRootWorkspaceId: string | null;
}): BranchSegmentEntry[] {
  const localBranches = branches.filter((branch) => !branch.is_remote);
  const mainName =
    localBranches.find((branch) => branch.is_current)?.name ??
    mainDirectoryBranch;
  const currentName = inWorktree
    ? currentDirectoryBranch
    : (currentDirectoryBranch ?? mainName);

  if (!inWorktree) {
    const currentKey = normalizeBranch(currentName);
    return [...localBranches]
      .filter(
        (branch) => !branch.is_worktree || sameBranch(branch.name, currentName)
      )
      .sort((left, right) => {
        const leftRank = normalizeBranch(left.name) === currentKey ? 0 : 1;
        const rightRank = normalizeBranch(right.name) === currentKey ? 0 : 1;
        return leftRank - rightRank;
      })
      .map((branch) => ({
        name: branch.name,
        role: sameBranch(branch.name, currentName) ? 'current' : 'available',
        workspaceId: null,
      }));
  }

  const entries: BranchSegmentEntry[] = [];
  if (mainName) {
    entries.push({
      name: mainName,
      role: 'main-directory',
      workspaceId: projectRootWorkspaceId,
    });
  }
  if (currentName && !sameBranch(currentName, mainName)) {
    entries.push({
      name: currentName,
      role: 'current',
      workspaceId: null,
    });
  }

  const seen = new Set(entries.map((entry) => normalizeBranch(entry.name)));
  for (const branch of localBranches) {
    const key = normalizeBranch(branch.name);
    if (seen.has(key) || branch.is_current || branch.is_worktree) {
      continue;
    }
    seen.add(key);
    entries.push({
      name: branch.name,
      role: 'available',
      workspaceId: null,
    });
  }

  return entries;
}
