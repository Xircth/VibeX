import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutorProfileId } from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import {
  buildCancelQueueMutationInput,
  buildQueueMutationInput,
  getQueueIndicatorState,
  getQueueSnapshot,
  getQueueStatusQueryKey,
  type QueueStatus,
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
        queryClient.getQueryData<QueueStatus>(
          getQueueStatusQueryKey(sessionId)
        ) ?? EMPTY_QUEUE_STATUS
      ),
    enabled: Boolean(sessionId),
  });
  const refreshQueueStatus = useCallback(async () => {
    if (!sessionId) return { data: EMPTY_QUEUE_STATUS } as const;
    const status =
      queryClient.getQueryData<QueueStatus>(
        getQueueStatusQueryKey(sessionId)
      ) ?? EMPTY_QUEUE_STATUS;
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

  const startQueuedTurnMutation = useMutation({
    mutationFn: ({
      sessionId,
      message,
      agentMessage,
      images,
      executorProfileId,
      pluginActions,
    }: {
      sessionId: string;
      message: string;
      agentMessage?: string;
      images: string[];
      executorProfileId: ExecutorProfileId;
      pluginActions: SessionComposerPluginActionInvocation[];
    }) =>
      sendAgentRuntimeTurn({
        workspaceId: workspaceId ?? '',
        sessionId,
        text: agentMessage ?? message,
        displayText: message,
        images,
        executorProfileId,
        pluginActions,
      }),
    onSuccess: (_turn, variables) => {
      queryClient.setQueryData(
        getQueueStatusQueryKey(variables.sessionId),
        EMPTY_QUEUE_STATUS
      );
    },
  });

  // A conversation has one active turn. Persist the follow-up locally while it
  // runs, then use the normal start-turn path only after it settles.
  const dispatchedQueueKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const queuedMessage = getQueueSnapshot(queueStatus).queuedMessage;
    const queueKey = queuedMessage?.created_at ?? null;
    if (
      isAttemptRunning ||
      !workspaceId ||
      !sessionId ||
      !queuedMessage ||
      !queueKey ||
      dispatchedQueueKeyRef.current === queueKey
    ) {
      return;
    }

    dispatchedQueueKeyRef.current = queueKey;
    void startQueuedTurnMutation.mutateAsync({
      sessionId,
      message: queuedMessage.data.message,
      agentMessage: queuedMessage.data.agentMessage,
      images: queuedMessage.data.images,
      executorProfileId: queuedMessage.executorProfileId,
      pluginActions: queuedMessage.data.pluginActions ?? [],
    });
  }, [
    isAttemptRunning,
    queueStatus,
    sessionId,
    startQueuedTurnMutation,
    workspaceId,
  ]);

  const queueMutation = useMutation({
    mutationFn: async ({
      sessionId,
      message,
      agentMessage,
      images,
      executorProfileId,
      pluginActions,
    }: {
      sessionId: string;
      message: string;
      agentMessage?: string;
      images: string[];
      executorProfileId: ExecutorProfileId;
      pluginActions: SessionComposerPluginActionInvocation[];
    }) => ({
      sessionId,
      message,
      agentMessage,
      images,
      executorProfileId,
      pluginActions,
      createdAt: new Date().toISOString(),
    }),
    onSuccess: (message) => {
      const status: QueueStatus = {
        status: 'queued',
        message: {
          session_id: message.sessionId,
          created_at: message.createdAt,
          updated_at: message.createdAt,
          executorProfileId: message.executorProfileId,
          data: {
            message: message.message,
            agentMessage: message.agentMessage,
            images: message.images,
            pluginActions: message.pluginActions,
          },
        },
      };
      queryClient.setQueryData(
        getQueueStatusQueryKey(message.sessionId),
        status
      );
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
      images: string[] = [],
      pluginActions: SessionComposerPluginActionInvocation[] = [],
      agentMessage?: string
    ) => {
      const queueInput = buildQueueMutationInput({
        sessionId,
        message,
        agentMessage,
        images,
        executorProfileId,
        pluginActions,
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
    isQueueLoading:
      queueMutation.isPending ||
      startQueuedTurnMutation.isPending ||
      cancelMutation.isPending,
    isQueued,
    queueIndicatorState: getQueueIndicatorState(queueStatus, isAttemptRunning),
  };
}
