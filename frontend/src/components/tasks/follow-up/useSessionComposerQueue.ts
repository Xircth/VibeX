import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutorProfileId, QueueStatus } from 'shared/types';
import { queueApi } from '@/lib/api';
import {
  buildCancelQueueMutationInput,
  buildQueueMutationInput,
  getQueueIndicatorState,
  getQueueSnapshot,
  getQueueStatusQueryKey,
  shouldRefreshQueueStatus,
} from './sessionComposerQueue';

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty' };

export function useSessionComposerQueue({
  sessionId,
  workspaceId,
  isAttemptRunning,
  processCount = 0,
}: {
  sessionId: string | undefined;
  workspaceId?: string | null;
  isAttemptRunning: boolean;
  processCount?: number;
}) {
  const queryClient = useQueryClient();
  const {
    data: queueStatus = EMPTY_QUEUE_STATUS,
    refetch: refreshQueueStatus,
  } = useQuery<QueueStatus>({
    queryKey: getQueueStatusQueryKey(sessionId),
    queryFn: () =>
      sessionId ? queueApi.getStatus(sessionId) : Promise.resolve(EMPTY_QUEUE_STATUS),
    enabled: Boolean(sessionId),
  });
  const prevProcessCountRef = useRef(processCount);

  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processCount;
    if (
      shouldRefreshQueueStatus({
        hasWorkspace: !!workspaceId,
        isAttemptRunning,
        previousProcessCount: prevCount,
        currentProcessCount: processCount,
      })
    ) {
      void refreshQueueStatus();
    }
  }, [isAttemptRunning, workspaceId, processCount, refreshQueueStatus]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshQueueStatus();
  }, [refreshQueueStatus, sessionId]);

  const queueMutation = useMutation({
    mutationFn: ({
      sessionId,
      message,
      images,
      executorProfileId,
    }: {
      sessionId: string;
      message: string;
      images: string[];
      executorProfileId: ExecutorProfileId;
    }) =>
      queueApi.queue(sessionId, {
        message,
        images,
        executor_profile_id: executorProfileId,
      }),
    onSuccess: (status, variables) => {
      queryClient.setQueryData(
        getQueueStatusQueryKey(variables.sessionId),
        status
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string }) =>
      queueApi.cancel(sessionId),
    onSuccess: (status, variables) => {
      queryClient.setQueryData(
        getQueueStatusQueryKey(variables.sessionId),
        status
      );
    },
  });

  const queueMessage = useCallback(
    async (
      message: string,
      executorProfileId: ExecutorProfileId,
      images: string[] = []
    ) => {
      const queueInput = buildQueueMutationInput({
        sessionId,
        message,
        images,
        executorProfileId,
      });
      if (!queueInput) return;
      await queueMutation.mutateAsync(queueInput);
    },
    [sessionId, queueMutation]
  );

  const cancelQueue = useCallback(async () => {
    const cancelInput = buildCancelQueueMutationInput(sessionId);
    if (!cancelInput) return;
    await cancelMutation.mutateAsync(cancelInput);
  }, [sessionId, cancelMutation]);

  const { isQueued } = getQueueSnapshot(queueStatus);

  return {
    queueStatus,
    refreshQueueStatus,
    queueMutation,
    cancelMutation,
    queueMessage,
    cancelQueue,
    isQueueLoading: queueMutation.isPending || cancelMutation.isPending,
    isQueued,
    queueIndicatorState: getQueueIndicatorState(queueStatus, isAttemptRunning),
  };
}
