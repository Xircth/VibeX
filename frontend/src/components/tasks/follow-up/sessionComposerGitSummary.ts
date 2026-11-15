type RepoIdLike = {
  id: string;
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
