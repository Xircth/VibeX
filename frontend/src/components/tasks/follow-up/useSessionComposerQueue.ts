import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationInputPayload, ExecutorProfileId } from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';
import {
  getQueueIndicatorState,
  getQueueStatusQueryKey,
  inputViewToQueuedMessage,
  type QueuedMessage,
  type QueueStatus,
} from './sessionComposerQueue';
import { conversationApi } from '@/features/conversation/conversationApi';

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty', messages: [] };

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
  const editingInputRef = useRef<QueuedMessage | null>(null);
  const queryKey = getQueueStatusQueryKey(sessionId);
  const { data: queueStatus = EMPTY_QUEUE_STATUS, refetch } =
    useQuery<QueueStatus>({
      queryKey,
      queryFn: async () => {
        if (!sessionId) return EMPTY_QUEUE_STATUS;
        const inputs = await conversationApi.listInputs(sessionId);
        const messages = inputs
          .filter((input) => ['queued', 'claimed'].includes(input.status))
          .map(inputViewToQueuedMessage);
        return messages.length === 0
          ? EMPTY_QUEUE_STATUS
          : { status: 'queued', messages };
      },
      enabled: Boolean(sessionId),
      // Process transitions are a cheap signal that a claim/dispatch may have
      // changed. Durable events remain the authority; this only refreshes the view.
      // A second window can enqueue while this one is idle. Event publication is
      // the fast path; bounded polling guarantees eventual convergence if a host
      // event is missed during suspension or reconnect.
      refetchInterval: isAttemptRunning ? 2_000 : 5_000,
    });

  const refreshQueueStatus = useCallback(async () => {
    if (!sessionId) return { data: EMPTY_QUEUE_STATUS } as const;
    return refetch();
  }, [refetch, sessionId]);

  useEffect(() => {
    if (sessionId) void refetch();
  }, [processCount, refetch, sessionId]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

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
    }) => {
      const payload: ConversationInputPayload = {
        agentId: executorProfileId.executor,
        workspaceId: workspaceId ?? '',
        executorProfileId:
          executorProfileId as unknown as ConversationInputPayload['executorProfileId'],
        text: agentMessage ?? message,
        displayText: message,
        images,
        pluginActions,
      };
      const editing = editingInputRef.current;
      if (editing?.session_id === sessionId && editing.status === 'queued') {
        const updated = await conversationApi.updateInput({
          conversationId: sessionId,
          inputId: editing.id,
          expectedRevision: Number(editing.revision),
          payload,
        });
        editingInputRef.current = null;
        return updated;
      }
      return (await conversationApi.submitInput(sessionId, payload)).input;
    },
    onSuccess: refresh,
  });

  const cancelMutation = useMutation({
    mutationFn: (message: QueuedMessage) =>
      conversationApi.cancelInput({
        conversationId: message.session_id,
        inputId: message.id,
        expectedRevision: Number(message.revision),
      }),
    onSuccess: refresh,
  });

  const reorderMutation = useMutation({
    mutationFn: ({
      message,
      sortKey,
    }: {
      message: QueuedMessage;
      sortKey: bigint;
    }) =>
      conversationApi.reorderInput({
        conversationId: message.session_id,
        inputId: message.id,
        expectedRevision: Number(message.revision),
        sortKey: Number(sortKey),
      }),
    onSuccess: refresh,
  });

  const queueMessage = useCallback(
    async (
      message: string,
      executorProfileId: ExecutorProfileId,
      images: string[] = [],
      pluginActions: SessionComposerPluginActionInvocation[] = [],
      agentMessage?: string
    ) => {
      if (!sessionId || !workspaceId) return;
      await queueMutation.mutateAsync({
        sessionId,
        message,
        agentMessage,
        images,
        executorProfileId,
        pluginActions,
      });
    },
    [queueMutation, sessionId, workspaceId]
  );

  const cancelQueue = useCallback(
    async (message?: QueuedMessage) => {
      const target = message ?? queueStatus.messages.at(-1);
      if (!target || target.status !== 'queued') return;
      await cancelMutation.mutateAsync(target);
    },
    [cancelMutation, queueStatus.messages]
  );

  const beginEditQueue = useCallback((message: QueuedMessage) => {
    if (message.status === 'queued') editingInputRef.current = message;
  }, []);

  const moveQueue = useCallback(
    async (message: QueuedMessage, direction: -1 | 1) => {
      const index = queueStatus.messages.findIndex(
        (candidate) => candidate.id === message.id
      );
      const neighbor = queueStatus.messages[index + direction];
      if (!neighbor || message.status !== 'queued') return;
      const outerNeighbor = queueStatus.messages[index + direction * 2];
      const sortKey = outerNeighbor
        ? (neighbor.sortKey + outerNeighbor.sortKey) / 2n
        : neighbor.sortKey + BigInt(direction) * 1024n;
      await reorderMutation.mutateAsync({ message, sortKey });
    },
    [queueStatus.messages, reorderMutation]
  );

  const queuedMessages = queueStatus.messages;
  const isQueued = queuedMessages.length > 0;

  return {
    queueStatus,
    queuedMessages,
    refreshQueueStatus,
    queueMutation,
    cancelMutation,
    reorderMutation,
    queueMessage,
    cancelQueue,
    beginEditQueue,
    moveQueue,
    isQueueLoading:
      queueMutation.isPending ||
      cancelMutation.isPending ||
      reorderMutation.isPending,
    isQueued,
    queueIndicatorState: getQueueIndicatorState(queueStatus, isAttemptRunning),
  };
}
