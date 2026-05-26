import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import { getSessionRenameInvalidation } from './sessionComposerSession';

export function useSessionComposerSessionRename({
  workspaceId,
}: {
  workspaceId: string | null | undefined;
}) {
  const queryClient = useQueryClient();

  const handleRenameSession = useCallback(
    async (targetSessionId: string, name: string | null) => {
      await sessionsApi.rename(targetSessionId, name);
      const invalidation = getSessionRenameInvalidation({
        targetSessionId,
        workspaceId,
      });
      if (invalidation.workspaceSessionsQueryKey) {
        await queryClient.invalidateQueries({
          queryKey: invalidation.workspaceSessionsQueryKey,
        });
      }
      queryClient.invalidateQueries({
        queryKey: invalidation.sessionQueryKey,
      });
    },
    [queryClient, workspaceId]
  );

  return { handleRenameSession };
}
