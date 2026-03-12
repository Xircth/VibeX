import { useQuery } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';
import type { RepoBranchStatus } from 'shared/types';

const POLL_INTERVAL_MS = 5000;

/**
 * Polls workspace branch status every 5 seconds.
 * Returns per-repo branch status including ahead/behind counts,
 * conflict state, and merge info.
 */
export function useWorkspaceBranchStatus(workspaceId?: string) {
  return useQuery<RepoBranchStatus[]>({
    queryKey: ['branchStatus', workspaceId],
    queryFn: () => attemptsApi.getBranchStatus(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: POLL_INTERVAL_MS,
    // Keep previous data while refetching to avoid UI flicker
    placeholderData: (prev) => prev,
  });
}
