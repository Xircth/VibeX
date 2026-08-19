import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type {
  AgentSessionConfigOverride,
  ExecutorProfileId,
} from 'shared/types';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { publishOptimisticConversationTurn } from '@/features/conversation/optimisticTurnEvents';
import {
  buildAgentPrompt,
  isSessionScopedSlashCommand,
} from '@/utils/promptMessage';
import {
  getSessionComposerFileRefs,
  getSessionComposerPluginActionInvocations,
  serializeSessionComposerBackendMessage,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

type Args = {
  sessionId?: string;
  sessionExecutor?: string | null;
  workspaceId?: string;
  isNewSessionMode?: boolean;
  newSessionName?: string;
  onSelectSession?: (sessionId: string) => void;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  message: string;
  images?: string[];
  conflictMarkdown: string | null;
  reviewMarkdown: string;
  executorProfileId: ExecutorProfileId | null;
  /** Composer-selected, agent-advertised session mode applied to this turn. */
  modeOverride?: string | null;
  /** Pending agent-advertised config overrides (model / permission …) for this turn. */
  configOverrides?: AgentSessionConfigOverride[];
  clearComments: () => void;
  onBeforeSend?: () => void;
  onSendFailure?: (message: string) => void;
  onAfterSendCleanup: () => void | Promise<void>;
};

let optimisticTurnSequence = 0;

export function useFollowUpSend({
  sessionId,
  sessionExecutor,
  workspaceId,
  isNewSessionMode,
  newSessionName,
  onSelectSession,
  onSessionCreated,
  message,
  images = [],
  conflictMarkdown,
  reviewMarkdown,
  executorProfileId,
  modeOverride,
  configOverrides,
  clearComments,
  onBeforeSend,
  onSendFailure,
  onAfterSendCleanup,
}: Args) {
  const { t } = useTranslation(['app', 'common']);
  const queryClient = useQueryClient();
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  // React state does not close the acceptance boundary synchronously. Keep the
  // boundary in a ref so rapid clicks or re-entrant callbacks cannot create two
  // durable inputs while session creation or submission is still pending.
  const isSendingRef = useRef(false);
  const operationIdRef = useRef<string | null>(null);

  const sendFollowUp = useCallback(
    async (submittedMessage?: string) => {
      if (isSendingRef.current) return;
      if (!executorProfileId) return;

      const acceptedMessage = submittedMessage ?? message;
      const displayMessage = acceptedMessage.trim();
      const backendMessage =
        serializeSessionComposerBackendMessage(acceptedMessage).trim();
      const pluginActions =
        getSessionComposerPluginActionInvocations(acceptedMessage);
      const fileRefs = getSessionComposerFileRefs(acceptedMessage);
      const { prompt, isSlashCommand } = buildAgentPrompt(backendMessage, [
        conflictMarkdown,
        reviewMarkdown?.trim(),
      ]);
      const { prompt: displayPrompt } = buildAgentPrompt(displayMessage, [
        conflictMarkdown,
        reviewMarkdown?.trim(),
      ]);

      if (!prompt && images.length === 0) return;

      isSendingRef.current = true;
      operationIdRef.current ??= crypto.randomUUID();
      const operationId = operationIdRef.current;
      let turnAccepted = false;
      try {
        onBeforeSend?.();
        setIsSendingFollowUp(true);
        setFollowUpError(null);

        let targetSessionId = sessionId;
        let targetWorkspaceId = workspaceId;
        const shouldCreateNewSession =
          isNewSessionMode ||
          !targetSessionId ||
          (!!sessionExecutor && sessionExecutor !== executorProfileId.executor);

        if (shouldCreateNewSession && isSessionScopedSlashCommand(prompt)) {
          throw new Error(t('followUpSend.sessionScopedSlashCommandError'));
        }

        if (shouldCreateNewSession) {
          if (!workspaceId) return;

          const session = await sessionsApi.create({
            workspace_id: workspaceId,
            executor: executorProfileId.executor,
            name: newSessionName?.trim() ? newSessionName.trim() : null,
            initial_prompt: displayPrompt,
          });

          targetSessionId = session.id;
          targetWorkspaceId = session.workspace_id;
          onSelectSession?.(session.id);
          onSessionCreated?.({
            sessionId: session.id,
            workspaceId: session.workspace_id,
          });

          queryClient.invalidateQueries({
            queryKey: ['workspaceSessions', workspaceId],
          });
        }

        if (!targetSessionId) {
          throw new Error('No target session available for follow-up');
        }
        if (!targetWorkspaceId) {
          throw new Error('No workspace available for ACP agent turn');
        }

        const optimisticTurnId = `optimistic-${Date.now()}-${optimisticTurnSequence++}`;
        publishOptimisticConversationTurn({
          type: 'add',
          conversationId: targetSessionId,
          turn: {
            id: optimisticTurnId,
            role: 'user',
            blocks: displayPrompt
              ? [{ type: 'text', text: displayPrompt }]
              : [],
            timestamp: new Date().toISOString(),
          },
        });
        try {
          await sendAgentRuntimeTurn({
            workspaceId: targetWorkspaceId,
            sessionId: targetSessionId,
            executorProfileId,
            text: prompt,
            displayText: displayPrompt,
            images,
            modeOverride,
            configOverrides,
            workflowRefs: pluginActions.map((action) => ({
              pluginId: action.pluginId,
              workflowId: action.actionId,
            })),
            fileRefs,
            operationId,
          });
          turnAccepted = true;
          operationIdRef.current = null;
        } catch (error) {
          publishOptimisticConversationTurn({
            type: 'remove',
            conversationId: targetSessionId,
            turnId: optimisticTurnId,
          });
          throw error;
        }
        await queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', targetWorkspaceId],
        });
        if (!isSlashCommand) {
          clearComments();
        }
        await onAfterSendCleanup();
      } catch (error: unknown) {
        if (!turnAccepted) onSendFailure?.(acceptedMessage);
        const err = error as { message?: string };
        setFollowUpError(
          t('followUpSend.startFailed', {
            error: err.message ?? t('followUpSend.unknownError'),
          })
        );
      } finally {
        isSendingRef.current = false;
        setIsSendingFollowUp(false);
      }
    },
    [
      t,
      queryClient,
      sessionId,
      sessionExecutor,
      workspaceId,
      isNewSessionMode,
      newSessionName,
      onSelectSession,
      onSessionCreated,
      message,
      images,
      conflictMarkdown,
      reviewMarkdown,
      executorProfileId,
      modeOverride,
      configOverrides,
      clearComments,
      onBeforeSend,
      onSendFailure,
      onAfterSendCleanup,
    ]
  );

  const onSendFollowUp = useCallback(() => sendFollowUp(), [sendFollowUp]);
  const onSubmitFollowUp = useCallback(
    (submittedMessage: string) => sendFollowUp(submittedMessage),
    [sendFollowUp]
  );

  return {
    isSendingFollowUp,
    followUpError,
    setFollowUpError,
    onSendFollowUp,
    onSubmitFollowUp,
  } as const;
}
