import {
  getContextCompactStatusText,
  isContextCompactPrompt,
} from '@/lib/contextCompact';
import {
  ExecutionProcessStatus,
  NormalizedEntry,
  PatchType,
} from 'shared/types';
import type { ExecutionProcessState, PatchTypeWithKey } from './types';

type ConversationContextCompactDisplay = {
  entry: PatchTypeWithKey;
  isRunning: boolean;
  isFailedOrKilled: boolean;
};

export function getConversationContextCompactDisplay(
  processState: ExecutionProcessState,
  compactProcessStatus: ExecutionProcessStatus | undefined
): ConversationContextCompactDisplay | null {
  const actionType = processState.executionProcess.executor_action.typ;
  if (!('prompt' in actionType) || !isContextCompactPrompt(actionType.prompt)) {
    return null;
  }

  const isFailedOrKilled =
    compactProcessStatus === ExecutionProcessStatus.failed ||
    compactProcessStatus === ExecutionProcessStatus.killed;
  const compactStatusEntryType = isFailedOrKilled
    ? ({
        type: 'error_message',
        error_type: {
          type: 'other',
        },
      } as const)
    : ({
        type: 'system_message',
      } as const);
  const compactStatusEntry: NormalizedEntry = {
    entry_type: compactStatusEntryType,
    content: getContextCompactStatusText(compactProcessStatus),
    timestamp: null,
  };
  const compactPatch: PatchType = {
    type: 'NORMALIZED_ENTRY',
    content: compactStatusEntry,
  };

  return {
    entry: {
      ...compactPatch,
      patchKey: `${processState.executionProcess.id}:context-compact`,
      executionProcessId: processState.executionProcess.id,
    },
    isRunning: compactProcessStatus === ExecutionProcessStatus.running,
    isFailedOrKilled,
  };
}
