import type { GitBranch, Workspace } from 'shared/types';

export interface WorkspaceBranchOption {
  value: string;
  branch: string;
  workspace: Workspace | null;
  existingWorkspaceId: string | null;
  directWorkspaceId: string | null;
  useWorktree: boolean;
  isCurrentProjectBranch: boolean;
}

function normalizeBranchName(branch: string): string {
  return branch.trim().toLowerCase();
}

function compareWorkspacePriority(
  current: Workspace | null,
  candidate: Workspace
): Workspace {
  if (!current) {
    return candidate;
  }

  if (current.use_worktree !== candidate.use_worktree) {
    return candidate.use_worktree ? candidate : current;
  }

  const currentUpdatedAt = new Date(current.updated_at).getTime();
  const candidateUpdatedAt = new Date(candidate.updated_at).getTime();

  return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
}

function createOptionValue(
  workspace: Workspace | null,
  branch: string
): string {
  if (workspace?.use_worktree) {
    return `workspace:${workspace.id}`;
  }

  return `branch:${branch}`;
}

export function buildWorkspaceBranchOptions({
  workspaces,
  repoBranches,
}: {
  workspaces: Workspace[];
  repoBranches: GitBranch[];
}): WorkspaceBranchOption[] {
  const localBranches = repoBranches.filter((branch) => !branch.is_remote);
  const currentProjectBranch =
    localBranches.find((branch) => branch.is_current)?.name ?? null;
  const workspaceByBranch = new Map<string, Workspace>();

  workspaces.forEach((workspace) => {
    const key = normalizeBranchName(workspace.branch);
    workspaceByBranch.set(
      key,
      compareWorkspacePriority(workspaceByBranch.get(key) ?? null, workspace)
    );
  });

  const options: WorkspaceBranchOption[] = [];
  const seenBranches = new Set<string>();

  const pushOption = (branch: string, workspace: Workspace | null) => {
    const key = normalizeBranchName(branch);
    if (seenBranches.has(key)) {
      return;
    }

    seenBranches.add(key);
    options.push({
      value: createOptionValue(workspace, branch),
      branch,
      workspace,
      existingWorkspaceId: workspace?.id ?? null,
      directWorkspaceId: workspace?.use_worktree ? workspace.id : null,
      useWorktree: workspace?.use_worktree ?? false,
      isCurrentProjectBranch:
        currentProjectBranch !== null &&
        normalizeBranchName(currentProjectBranch) === key,
    });
  };

  localBranches.forEach((branch) => {
    const key = normalizeBranchName(branch.name);
    pushOption(branch.name, workspaceByBranch.get(key) ?? null);
  });

  workspaces.forEach((workspace) => {
    pushOption(workspace.branch, workspace);
  });

  return options;
}

export function findWorkspaceBranchOption(
  options: WorkspaceBranchOption[],
  value: string
): WorkspaceBranchOption | null {
  return options.find((option) => option.value === value) ?? null;
}

export function findWorkspaceBranchOptionByWorkspaceId(
  options: WorkspaceBranchOption[],
  workspaceId: string | null | undefined
): WorkspaceBranchOption | null {
  if (!workspaceId) {
    return null;
  }

  return (
    options.find((option) => option.existingWorkspaceId === workspaceId) ?? null
  );
}

export function matchesWorkspaceBranch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }

  return normalizeBranchName(left) === normalizeBranchName(right);
}

export function getWorkspaceBranchWarning(
  option: WorkspaceBranchOption | null
): string | null {
  if (!option || option.useWorktree) {
    return null;
  }

  return '当前分支非 Git Worktree，建议选择 Worktree 分支。';
}

export function getWorkspaceBranchCheckoutHint(
  option: WorkspaceBranchOption | null
): string | null {
  if (!option || option.useWorktree || option.isCurrentProjectBranch) {
    return null;
  }

  return '选择后会先在当前项目目录 checkout 到该分支，以确保工作区正确。';
}
