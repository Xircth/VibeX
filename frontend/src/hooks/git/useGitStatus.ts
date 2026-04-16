import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, repoApi } from '@/lib/api';
import type { DetailedGitStatus, GitFileStatusEntry } from 'shared/types';

type PollMode = 'active' | 'background' | 'paused';

interface UseGitStatusOptions {
  workspaceId: string | null;
  repoId: string | null;
  pollMode?: PollMode;
}

interface UseGitStatusReturn {
  branchName: string;
  stagedFiles: GitFileStatusEntry[];
  unstagedFiles: GitFileStatusEntry[];
  totalAdditions: number;
  totalDeletions: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_FILES: GitFileStatusEntry[] = [];

function getPollInterval(mode: PollMode, fileCount: number): number | false {
  if (mode === 'paused') return false;
  const isLarge = fileCount >= 120;
  if (mode === 'active') return isLarge ? 12000 : 3000;
  return isLarge ? 60000 : 30000;
}

export function useGitStatus({
  workspaceId,
  repoId,
  pollMode = 'active',
}: UseGitStatusOptions): UseGitStatusReturn {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['gitStatus', workspaceId, repoId],
    [workspaceId, repoId]
  );

  const {
    data: status,
    isLoading,
    error: queryError,
  } = useQuery<DetailedGitStatus>({
    queryKey,
    queryFn: async () => {
      return workspaceId
        ? await attemptsApi.getGitStatus(workspaceId, repoId!)
        : await repoApi.getGitStatus(repoId!);
    },
    enabled: !!repoId,
    refetchInterval: (query) => {
      const data = query.state.data;
      const fileCount =
        (data?.staged_files.length ?? 0) + (data?.unstaged_files.length ?? 0);
      return getPollInterval(pollMode, fileCount);
    },
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    branchName: status?.branch_name ?? '',
    stagedFiles: status?.staged_files ?? EMPTY_FILES,
    unstagedFiles: status?.unstaged_files ?? EMPTY_FILES,
    totalAdditions: status?.total_additions ?? 0,
    totalDeletions: status?.total_deletions ?? 0,
    isLoading,
    error: queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null,
    refresh,
  };
}
