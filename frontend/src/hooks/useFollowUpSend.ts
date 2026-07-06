import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type { ExecutorProfileId } from 'shared/types';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import {
  buildAgentPrompt,
  isSessionScopedSlashCommand,
} from '@/utils/promptMessage';
import { serializeSessionComposerBackendMessage } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

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
  clearComments: () => void;
  onBeforeSend?: () => void;
  onAfterSendCleanup: () => void | Promise<void>;
};

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
  clearComments,
  onBeforeSend,
  onAfterSendCleanup,
}: Args) {
  const { t } = useTranslation(['app', 'common']);
  const queryClient = useQueryClient();
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  // Synchronous re-entrancy guard. The submit shortcut reaches this callback
  // through both the global keyboard hook and the editor's `onSubmit`, and the
  // new-session path awaits a `sessionsApi.create` round-trip — without a
  // synchronous (ref, not state) guard a single Enter can invoke this twice and
  // start two turns, producing two responses for one user message.
  const isSendingRef = useRef(false);

  const onSendFollowUp = useCallback(async () => {
    if (isSendingRef.current) return;
    if (!executorProfileId) return;

    const displayMessage = message.trim();
    const backendMessage =
      serializeSessionComposerBackendMessage(message).trim();
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
          initial_prompt: prompt,
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

      await sendAgentRuntimeTurn({
        workspaceId: targetWorkspaceId,
        sessionId: targetSessionId,
        executorProfileId,
        text: prompt,
        displayText: displayPrompt,
        images,
        modeOverride,
      });
      if (!isSlashCommand) {
        clearComments();
      }
      await onAfterSendCleanup();
    } catch (error: unknown) {
      const err = error as { message?: string };
      setFollowUpError(
        t('followUpSend.startFailed', {
          error: err.message ?? t('followUpSend.unknownError'),
        }),
      );
    } finally {
      isSendingRef.current = false;
      setIsSendingFollowUp(false);
    }
  }, [
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
    clearComments,
    onBeforeSend,
    onAfterSendCleanup,
  ]);

  return {
    isSendingFollowUp,
    followUpError,
    setFollowUpError,
    onSendFollowUp,
  } as const;
}
