import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentSessionConfigOverride,
  ConversationInputPayload,
  ExecutorProfileId,
} from 'shared/types';
import {
  getSessionComposerFileRefs,
  type SessionComposerPluginActionInvocation,
} from './sessionComposerStructuredTokens';
import {
  getQueueIndicatorState,
  getQueueStatusQueryKey,
  waitingQueueMessages,
  type QueuedMessage,
  type QueueStatus,
} from './sessionComposerQueue';
import { conversationApi } from '@/features/conversation/conversationApi';
import { listenToConversationEvents } from '@/features/conversation/events';

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty', messages: [] };

export function useSessionComposerQueue({
  sessionId,
  workspaceId,
  isAttemptRunning,
  processCount = 0,
  modeOverride = null,
  configOverrides = [],
  excludeOperationId = null,
}: {
  sessionId: string | undefined;
  workspaceId?: string | null;
  isAttemptRunning: boolean;
  processCount?: number;
  modeOverride?: string | null;
  configOverrides?: AgentSessionConfigOverride[];
  excludeOperationId?: string | null;
}) {
  const queryClient = useQueryClient();
  const editingInputRef = useRef<QueuedMessage | null>(null);
  const [editingInput, setEditingInput] = useState<QueuedMessage | null>(null);
  const operationIdRef = useRef<string | null>(null);
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(
    null
  );
  const queryKey = getQueueStatusQueryKey(sessionId);
  const { data: queueStatus = EMPTY_QUEUE_STATUS, refetch } =
    useQuery<QueueStatus>({
      queryKey,
      queryFn: async () => {
        if (!sessionId) return EMPTY_QUEUE_STATUS;
        const inputs = await conversationApi.listInputs(sessionId);
        const messages = waitingQueueMessages(inputs);
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

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    listenToConversationEvents((batch) => {
      if (!active || batch.conversation_id !== sessionId) return;
      void refetch();
    }, sessionId)
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refetch, sessionId]);

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
        workflowRefs: pluginActions.map((action) => ({
          pluginId: action.pluginId,
          workflowId: action.actionId,
        })),
        modeOverride,
        configOverrides,
        fileRefs: getSessionComposerFileRefs(agentMessage ?? message),
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
        setEditingInput(null);
        operationIdRef.current = null;
        return updated;
      }
      operationIdRef.current ??= crypto.randomUUID();
      setPendingOperationId(operationIdRef.current);
      try {
        const submitted = await conversationApi.submitInput(
          sessionId,
          payload,
          operationIdRef.current
        );
        operationIdRef.current = null;
        return submitted.input;
      } finally {
        setPendingOperationId(null);
      }
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
    if (message.status !== 'queued') return;
    editingInputRef.current = message;
    setEditingInput(message);
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

  const queueIndicatorState = getQueueIndicatorState(queueStatus, {
    excludeOperationId: pendingOperationId ?? excludeOperationId,
  });
  const queuedMessages = queueIndicatorState.queuedMessages;
  const isQueued = queueIndicatorState.isQueued;

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
    editingInput,
    moveQueue,
    isQueueLoading:
      queueMutation.isPending ||
      cancelMutation.isPending ||
      reorderMutation.isPending,
    isQueued,
    queueIndicatorState,
  };
}
