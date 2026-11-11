import { useQuery } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';

export interface UseBranchStatusOptions {
  enabled?: boolean;
  poll?: boolean;
}

export function useBranchStatus(
  attemptId?: string,
  options?: UseBranchStatusOptions
) {
  const enabled = (options?.enabled ?? true) && !!attemptId;
  const poll = options?.poll ?? true;
  return useQuery({
    queryKey: ['branchStatus', attemptId],
    queryFn: () => attemptsApi.getBranchStatus(attemptId!),
    enabled,
    staleTime: 15_000,
    refetchInterval: poll ? 30_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

