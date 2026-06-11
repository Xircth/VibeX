import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutorProfileId, QueueStatus } from 'shared/types';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
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
  const prevProcessCountRef = useRef(processCount);
  const { data: queueStatus = EMPTY_QUEUE_STATUS } = useQuery<QueueStatus>({
    queryKey: getQueueStatusQueryKey(sessionId),
    queryFn: () =>
      Promise.resolve(
        queryClient.getQueryData<QueueStatus>(getQueueStatusQueryKey(sessionId)) ??
          EMPTY_QUEUE_STATUS
      ),
    enabled: Boolean(sessionId),
  });
  const refreshQueueStatus = useCallback(async () => {
    if (!sessionId) return { data: EMPTY_QUEUE_STATUS } as const;
    const status =
      queryClient.getQueryData<QueueStatus>(getQueueStatusQueryKey(sessionId)) ??
      EMPTY_QUEUE_STATUS;
    return { data: status } as const;
  }, [queryClient, sessionId]);

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
      sendAgentRuntimeTurn({
        workspaceId: workspaceId ?? '',
        sessionId,
        text: message,
        images,
        executorProfileId,
      }),
    onSuccess: (_prompt, variables) => {
      const status: QueueStatus = {
        status: 'queued',
        message: {
          session_id: variables.sessionId,
          queued_at: new Date().toISOString(),
          data: {
            message: variables.message,
            images: variables.images,
            executor_config: {
              executor: variables.executorProfileId.executor,
              variant: variables.executorProfileId.variant ?? null,
            },
            queued: true,
          },
        },
      };
      queryClient.setQueryData(getQueueStatusQueryKey(variables.sessionId), status);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      return { sessionId };
    },
    onSuccess: (_result, variables) => {
      queryClient.setQueryData(
        getQueueStatusQueryKey(variables.sessionId),
        EMPTY_QUEUE_STATUS
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
      if (!queueInput || !workspaceId) return;
      await queueMutation.mutateAsync(queueInput);
    },
    [sessionId, workspaceId, queueMutation]
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
