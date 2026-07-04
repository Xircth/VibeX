import { useMutation } from '@tanstack/react-query';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import {
  RestoreLogsDialog,
  type RestoreLogsDialogResult,
} from '@/components/dialogs';
import type {
  RepoBranchStatus,
  ExecutionProcess,
  AgentKind,
} from 'shared/types';

export interface RetryProcessParams {
  message: string;
  executor: AgentKind;
  variant: string | null;
  executionProcessId: string;
  branchStatus: RepoBranchStatus[] | undefined;
  processes: ExecutionProcess[] | undefined;
}

class RetryDialogCancelledError extends Error {
  constructor() {
    super('Retry dialog was cancelled');
    this.name = 'RetryDialogCancelledError';
  }
}

export function useRetryProcess(
  workspaceId: string,
  sessionId: string,
  onSuccess?: () => void,
  onError?: (err: unknown) => void
) {
  return useMutation({
    mutationFn: async ({
      message,
      executor,
      variant,
      executionProcessId,
      branchStatus,
      processes,
    }: RetryProcessParams) => {
      // Ask user for confirmation - dialog fetches its own preflight data
      let modalResult: RestoreLogsDialogResult | undefined;
      try {
        modalResult = await RestoreLogsDialog.show({
          executionProcessId,
          branchStatus,
          processes,
        });
      } catch {
        throw new RetryDialogCancelledError();
      }
      if (!modalResult || modalResult.action !== 'confirmed') {
        throw new RetryDialogCancelledError();
      }

      await sendAgentRuntimeTurn({
        workspaceId,
        sessionId,
        text: message,
        executorProfileId: { executor, variant },
      });
    },
    onSuccess: () => {
      onSuccess?.();
    },
    onError: (err) => {
      // Don't report cancellation as an error
      if (err instanceof RetryDialogCancelledError) {
        return;
      }
      console.error('Failed to send retry:', err);
      onError?.(err);
    },
  });
}

export { RetryDialogCancelledError };
