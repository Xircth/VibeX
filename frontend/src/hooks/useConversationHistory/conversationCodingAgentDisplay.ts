import {
  ExecutionProcessStatus,
  NormalizedEntry,
  PatchType,
} from 'shared/types';
import { makeLoadingPatch } from './constants';
import { getConversationContextCompactDisplay } from './conversationContextCompactDisplay';
import type { ExecutionProcessState, PatchTypeWithKey } from './types';

type ConversationCodingAgentDisplay = {
  entries: PatchTypeWithKey[];
  nextAssistantTranscript: string;
  hasPendingApproval: boolean;
  isRunning: boolean;
  isFailedOrKilled: boolean;
  setupHelpText: string | undefined;
};

type ConversationCodingAgentDisplayOptions = {
  previousAssistantTranscript: string;
  liveProcessStatus?: ExecutionProcessStatus;
};

function isCodingAgentDisplayAction(
  actionType: ExecutionProcessState['executionProcess']['executor_action']['typ']
): actionType is Extract<
  ExecutionProcessState['executionProcess']['executor_action']['typ'],
  | { type: 'CodingAgentInitialRequest' }
  | { type: 'CodingAgentFollowUpRequest' }
  | { type: 'ReviewRequest' }
> {
  return (
    actionType.type === 'CodingAgentInitialRequest' ||
    actionType.type === 'CodingAgentFollowUpRequest' ||
    actionType.type === 'ReviewRequest'
  );
}

function patchWithKey(
  patch: PatchType,
  executionProcessId: string,
  index: number | string
): PatchTypeWithKey {
  return {
    ...patch,
    patchKey: `${executionProcessId}:${index}`,
    executionProcessId,
  };
}

export function stripPreviouslyDisplayedAssistantPrefix(
  content: string,
  previousAssistantTranscript: string
): string {
  if (
    previousAssistantTranscript.length < 20 ||
    content.length <= previousAssistantTranscript.length ||
    !content.startsWith(previousAssistantTranscript)
  ) {
    return content;
  }

  const stripped = content.slice(previousAssistantTranscript.length);
  return stripped.trimStart() || content;
}

export function getConversationCodingAgentDisplay(
  processState: ExecutionProcessState,
  options: ConversationCodingAgentDisplayOptions
): ConversationCodingAgentDisplay | null {
  const actionType = processState.executionProcess.executor_action.typ;
  if (!isCodingAgentDisplayAction(actionType)) {
    return null;
  }

  const compactDisplay = getConversationContextCompactDisplay(
    processState,
    options.liveProcessStatus
  );
  if (compactDisplay) {
    return {
      entries: [compactDisplay.entry],
      nextAssistantTranscript: options.previousAssistantTranscript,
      hasPendingApproval: false,
      isRunning: compactDisplay.isRunning,
      isFailedOrKilled: compactDisplay.isFailedOrKilled,
      setupHelpText: undefined,
    };
  }

  const entries: PatchTypeWithKey[] = [];
  const userNormalizedEntry: NormalizedEntry = {
    entry_type: {
      type: 'user_message',
    },
    content: actionType.prompt,
    timestamp: null,
  };
  const userPatch: PatchType = {
    type: 'NORMALIZED_ENTRY',
    content: userNormalizedEntry,
  };
  entries.push(patchWithKey(userPatch, processState.executionProcess.id, 'user'));

  let nextAssistantTranscript = options.previousAssistantTranscript;
  const filteredEntries = processState.entries
    .filter(
      (entry) =>
        entry.type !== 'NORMALIZED_ENTRY' ||
        (entry.content.entry_type.type !== 'user_message' &&
          entry.content.entry_type.type !== 'token_usage_info')
    )
    .map((entry) => {
      if (
        entry.type !== 'NORMALIZED_ENTRY' ||
        entry.content.entry_type.type !== 'assistant_message'
      ) {
        return entry;
      }

      const strippedContent = stripPreviouslyDisplayedAssistantPrefix(
        entry.content.content,
        options.previousAssistantTranscript
      );
      if (strippedContent === entry.content.content) {
        return entry;
      }

      return {
        ...entry,
        content: {
          ...entry.content,
          content: strippedContent,
        },
      };
    });

  const hasPendingApproval = filteredEntries.some((entry) => {
    if (entry.type !== 'NORMALIZED_ENTRY') return false;
    const entryType = entry.content.entry_type;
    return (
      entryType.type === 'tool_use' &&
      entryType.status.status === 'pending_approval'
    );
  });

  entries.push(...filteredEntries);
  for (const entry of filteredEntries) {
    if (
      entry.type === 'NORMALIZED_ENTRY' &&
      entry.content.entry_type.type === 'assistant_message' &&
      entry.content.content.trim().length > 0
    ) {
      nextAssistantTranscript += entry.content.content;
    }
  }

  const isRunning = options.liveProcessStatus === ExecutionProcessStatus.running;
  const isFailedOrKilled =
    options.liveProcessStatus === ExecutionProcessStatus.failed ||
    options.liveProcessStatus === ExecutionProcessStatus.killed;
  let setupHelpText: string | undefined;
  if (isFailedOrKilled) {
    for (const entry of filteredEntries) {
      if (
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'error_message' &&
        entry.content.entry_type.error_type.type === 'setup_required'
      ) {
        setupHelpText = entry.content.content;
        break;
      }
    }
  }

  if (isRunning && !hasPendingApproval) {
    entries.push(makeLoadingPatch(processState.executionProcess.id));
  }

  return {
    entries,
    nextAssistantTranscript,
    hasPendingApproval,
    isRunning,
    isFailedOrKilled,
    setupHelpText,
  };
}
