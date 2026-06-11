import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import {
  buildCompactContextTurnInput,
  getCompactContextErrorMessage,
  getIsCompactingContext,
} from './sessionComposerCompact';
import {
  canCompactContext as getCanCompactContext,
  canTypeFollowUp as getCanTypeFollowUp,
} from './sessionComposerSubmit';

type CompactProcess = {
  id: string;
  status: string;
  executor_action?: {
    typ?: unknown;
  } | null;
};

export function useSessionComposerContextCompact({
  sessionId,
  workspaceId,
  executorProfile,
  processes,
  setFollowUpError,
  clearStopping,
  hasWorkspaceForTyping,
  isSendingFollowUp,
  isRetryActive,
  hasPendingApproval,
  isAttemptRunning,
  isAwaitingNewSessionConfirmation,
  isNewSessionMode,
}: {
  sessionId: string | null | undefined;
  workspaceId: string | null | undefined;
  executorProfile: ExecutorProfileId | null | undefined;
  processes: CompactProcess[];
  setFollowUpError: (message: string | null) => void;
  clearStopping: () => void;
  hasWorkspaceForTyping: boolean;
  isSendingFollowUp: boolean;
  isRetryActive: boolean;
  hasPendingApproval: boolean;
  isAttemptRunning: boolean;
  isAwaitingNewSessionConfirmation: boolean;
  isNewSessionMode: boolean;
}) {
  const [pendingCompactProcessId, setPendingCompactProcessId] = useState<
    string | null
  >(null);
  void processes;

  useEffect(() => {
    if (!pendingCompactProcessId) return;

    const timeout = window.setTimeout(() => {
      setPendingCompactProcessId((current) =>
        current === pendingCompactProcessId ? null : current
      );
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [pendingCompactProcessId]);

  const isCompactingContext = getIsCompactingContext({
    pendingCompactProcessId,
  });
  const canTypeForCompact = useMemo(
    () =>
      getCanTypeFollowUp({
        hasWorkspace: hasWorkspaceForTyping,
        isSendingFollowUp,
        isRetryActive,
        hasPendingApproval,
        isCompactingContext,
      }),
    [
      hasWorkspaceForTyping,
      isSendingFollowUp,
      isRetryActive,
      hasPendingApproval,
      isCompactingContext,
    ]
  );
  const canCompactContext = useMemo(
    () =>
      getCanCompactContext({
        hasSession: Boolean(sessionId),
        hasWorkspace: Boolean(workspaceId),
        hasExecutor: Boolean(executorProfile?.executor),
        canType: canTypeForCompact,
        isAttemptRunning,
        isAwaitingNewSessionConfirmation,
        isNewSessionMode,
      }),
    [
      sessionId,
      workspaceId,
      executorProfile?.executor,
      canTypeForCompact,
      isAttemptRunning,
      isAwaitingNewSessionConfirmation,
      isNewSessionMode,
    ]
  );

  const handleCompactContext = useCallback(async () => {
    const compactTurnInput = buildCompactContextTurnInput({
      sessionId,
      workspaceId,
      executorProfile,
      canCompact: canCompactContext,
    });
    if (!compactTurnInput) return;

    try {
      setFollowUpError(null);
      clearStopping();

      const prompt = await sendAgentRuntimeTurn(compactTurnInput);
      setPendingCompactProcessId(prompt.id);
    } catch (error) {
      setFollowUpError(getCompactContextErrorMessage(error));
    }
  }, [
    canCompactContext,
    clearStopping,
    executorProfile,
    sessionId,
    setFollowUpError,
    workspaceId,
  ]);

  return {
    isCompactingContext,
    canCompactContext,
    handleCompactContext,
  };
}
