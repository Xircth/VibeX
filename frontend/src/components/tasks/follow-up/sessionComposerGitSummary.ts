type RepoIdLike = {
  id: string;
};

type ChangedFileLike = {
  path: string;
};

export function getSummaryRepoId(
  selectedRepoId: string | null | undefined,
  repos: readonly RepoIdLike[]
): string | null {
  if (selectedRepoId && repos.some((repo) => repo.id === selectedRepoId)) {
    return selectedRepoId;
  }

  return repos[0]?.id ?? null;
}

export function getChangedFileCount({
  stagedFiles,
  unstagedFiles,
}: {
  stagedFiles: readonly ChangedFileLike[];
  unstagedFiles: readonly ChangedFileLike[];
}): number {
  const changedPaths = new Set<string>();
  for (const file of stagedFiles) {
    changedPaths.add(file.path);
  }
  for (const file of unstagedFiles) {
    changedPaths.add(file.path);
  }
  return changedPaths.size;
}

export function shouldShowChangedFileSummary(fileCount: number): boolean {
  return fileCount > 0;
}
