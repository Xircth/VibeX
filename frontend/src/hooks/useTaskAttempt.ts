import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session, Workspace } from 'shared/types';
import { attemptsApi } from '@/lib/api';
import type { WorkspaceWithSession } from '@/types/attempt';

export function useTaskAttempt(attemptId?: string) {
  return useQuery({
    queryKey: ['taskAttempt', attemptId],
    queryFn: () => attemptsApi.get(attemptId!),
    enabled: !!attemptId,
  });
}

/**
 * Hook for components that need executor field (e.g., for capability checks).
 * Fetches workspace with executor from latest session.
 */
export function useTaskAttemptWithSession(attemptId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery<WorkspaceWithSession>({
    queryKey: ['taskAttemptWithSession', attemptId],
    queryFn: () => attemptsApi.getWithSession(attemptId!),
    enabled: !!attemptId,
  });

  useEffect(() => {
    if (!query.data) {
      return;
    }

    queryClient.setQueryData<Workspace>(
      ['taskAttempt', query.data.id],
      query.data
    );

    if (query.data.session) {
      queryClient.setQueryData<Session>(
        ['session', query.data.session.id],
        query.data.session
      );
    }
  }, [query.data, queryClient]);

  return query;
}
