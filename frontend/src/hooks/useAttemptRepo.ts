import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { attemptsApi } from '@/lib/api';
import type { RepoWithTargetBranch } from 'shared/types';

interface UseAttemptRepoOptions {
  enabled?: boolean;
}

export function useAttemptRepo(
  attemptId?: string,
  options: UseAttemptRepoOptions = {}
) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();

  const query = useQuery<RepoWithTargetBranch[]>({
    queryKey: ['attemptRepo', attemptId],
    queryFn: async () => {
      const repos = await attemptsApi.getRepos(attemptId!);
      return repos;
    },
    enabled: enabled && !!attemptId,
  });

  const repos = useMemo(() => query.data ?? [], [query.data]);

  // Use React Query cache for shared state across all hook consumers
  const { data: selectedRepoId = null } = useQuery<string | null>({
    queryKey: ['attemptRepoSelection', attemptId],
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });

  const setSelectedRepoId = useCallback(
    (id: string | null) => {
      queryClient.setQueryData(['attemptRepoSelection', attemptId], id);
    },
    [queryClient, attemptId]
  );

  // Auto-select first repo when none selected or when the current selection
  // does not belong to the active workspace anymore.
  useEffect(() => {
    if (repos.length === 0) {
      if (selectedRepoId !== null) {
        setSelectedRepoId(null);
      }
      return;
    }

    const hasSelectedRepo =
      selectedRepoId !== null && repos.some((repo) => repo.id === selectedRepoId);

    if (!hasSelectedRepo) {
      setSelectedRepoId(repos[0].id);
    }
  }, [repos, selectedRepoId, setSelectedRepoId]);

  return {
    repos,
    selectedRepoId,
    setSelectedRepoId,
    isLoading: query.isLoading,
    refetch: query.refetch,
  } as const;
}
