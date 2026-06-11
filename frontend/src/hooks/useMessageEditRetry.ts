import { useMutation } from '@tanstack/react-query';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import {
  RestoreLogsDialog,
  type RestoreLogsDialogResult,
} from '@/components/dialogs';
import type {
  RepoBranchStatus,
  ExecutionProcess,
  BaseCodingAgent,
} from 'shared/types';

export interface MessageEditRetryParams {
  message: string;
  executor: BaseCodingAgent;
  variant: string | null;
  executionProcessId: string;
  branchStatus: RepoBranchStatus[] | undefined;
  processes: ExecutionProcess[] | undefined;
}

class EditDialogCancelledError extends Error {
  constructor() {
    super('Edit dialog was cancelled');
    this.name = 'EditDialogCancelledError';
  }
}

export function useMessageEditRetry(
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
    }: MessageEditRetryParams) => {
      // Ask user for confirmation - dialog fetches its own preflight data
      let modalResult: RestoreLogsDialogResult | undefined;
      try {
        modalResult = await RestoreLogsDialog.show({
          executionProcessId,
          branchStatus,
          processes,
        });
      } catch {
        throw new EditDialogCancelledError();
      }
      if (!modalResult || modalResult.action !== 'confirmed') {
        throw new EditDialogCancelledError();
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
      if (err instanceof EditDialogCancelledError) {
        return;
      }
      console.error('Failed to send edited message:', err);
      onError?.(err);
    },
  });
}

export { EditDialogCancelledError };
