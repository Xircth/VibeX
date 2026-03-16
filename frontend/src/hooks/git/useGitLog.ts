import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, repoApi } from '@/lib/api';
import type { GitLogEntry, GitLogStatus } from 'shared/types';

interface UseGitLogOptions {
  workspaceId: string | null;
  repoId: string | null;
  enabled?: boolean;
}

interface UseGitLogReturn {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_ENTRIES: GitLogEntry[] = [];

export function useGitLog({
  workspaceId,
  repoId,
  enabled = true,
}: UseGitLogOptions): UseGitLogReturn {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['gitLog', workspaceId, repoId],
    [workspaceId, repoId]
  );

  const { data: logStatus, isLoading, error: queryError } = useQuery<GitLogStatus>({
    queryKey,
    queryFn: async () => {
      return workspaceId
        ? await attemptsApi.getGitLog(workspaceId, repoId!)
        : await repoApi.getGitLog(repoId!);
    },
    enabled: enabled && !!repoId,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    entries: logStatus?.entries ?? EMPTY_ENTRIES,
    total: logStatus?.total ?? 0,
    ahead: logStatus?.ahead ?? 0,
    behind: logStatus?.behind ?? 0,
    upstream: logStatus?.upstream ?? null,
    branchName: logStatus?.branch_name ?? '',
    isLoading,
    error: queryError ? (queryError instanceof Error ? queryError.message : String(queryError)) : null,
    refresh,
  };
}
