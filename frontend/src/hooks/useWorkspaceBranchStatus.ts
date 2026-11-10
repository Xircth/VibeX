import { useQuery } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';
import type { RepoBranchStatus } from 'shared/types';

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls workspace branch status on a background interval.
 * Returns per-repo branch status including ahead/behind counts,
 * conflict state, and merge info.
 */
export function useWorkspaceBranchStatus(workspaceId?: string) {
  return useQuery<RepoBranchStatus[]>({
    queryKey: ['branchStatus', workspaceId],
    queryFn: () => attemptsApi.getBranchStatus(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 15_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Keep previous data while refetching to avoid UI flicker
    placeholderData: (prev) => prev,
  });
}

