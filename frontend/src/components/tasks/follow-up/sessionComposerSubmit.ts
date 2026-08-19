import type { ExecutorProfileId } from 'shared/types';
import { buildAgentPrompt } from '@/utils/promptMessage';
import {
  clearComposerImageAttachments,
  type SessionComposerImageAttachment,
} from './sessionComposerImages';
import {
  getSessionComposerPluginActionInvocations,
  serializeSessionComposerBackendMessage,
  type SessionComposerPluginActionInvocation,
} from './sessionComposerStructuredTokens';

export type SubmitShortcutAction = 'send' | 'queue' | 'none';

export function isComposerExecutionActive({
  isAttemptRunning,
  isConversationTurnInFlight,
}: {
  isAttemptRunning: boolean;
  isConversationTurnInFlight: boolean;
}): boolean {
  return isAttemptRunning || isConversationTurnInFlight;
}

export function hasFollowUpContent({
  message,
  conflictMarkdown,
  reviewMarkdown,
  imageCount,
}: {
  message: string;
  conflictMarkdown: string | null | undefined;
  reviewMarkdown: string | null | undefined;
  imageCount: number;
}): boolean {
  return Boolean(
    message.trim() || conflictMarkdown || reviewMarkdown || imageCount > 0
  );
}

export function canTypeFollowUp({
  hasWorkspace,
  isSendingFollowUp,
  isRetryActive,
  hasPendingApproval,
  isCompactingContext,
}: {
  hasWorkspace: boolean;
  isSendingFollowUp: boolean;
  isRetryActive: boolean;
  hasPendingApproval: boolean;
  isCompactingContext: boolean;
}): boolean {
  return (
    hasWorkspace &&
    !isSendingFollowUp &&
    !isRetryActive &&
    !hasPendingApproval &&
    !isCompactingContext
  );
}

export function canEditFollowUp({
  isRetryActive,
  hasPendingApproval,
}: {
  isRetryActive: boolean;
  hasPendingApproval: boolean;
}): boolean {
  return !isRetryActive && !hasPendingApproval;
}

export function hasPendingToolApproval(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (!('type' in entry) || entry.type !== 'NORMALIZED_ENTRY') return false;
    if (!('content' in entry)) return false;

    const content = entry.content;
    if (!content || typeof content !== 'object') return false;
    if (!('entry_type' in content)) return false;

    const entryType = content.entry_type;
    if (!entryType || typeof entryType !== 'object') return false;
    const status =
      'status' in entryType &&
      entryType.status &&
      typeof entryType.status === 'object'
        ? entryType.status
        : null;

    return (
      'type' in entryType &&
      entryType.type === 'tool_use' &&
      !!status &&
      'status' in status &&
      status.status === 'pending_approval'
    );
  });
}

export function canSendFollowUp({
  canType,
  hasExecutor,
  isAwaitingNewSessionConfirmation,
  isNewSessionMode,
  message,
  conflictMarkdown,
  reviewMarkdown,
  imageCount,
}: {
  canType: boolean;
  hasExecutor: boolean;
  isAwaitingNewSessionConfirmation: boolean;
  isNewSessionMode: boolean;
  message: string;
  conflictMarkdown: string | null | undefined;
  reviewMarkdown: string | null | undefined;
  imageCount: number;
}): boolean {
  return (
    canType &&
    hasExecutor &&
    !isAwaitingNewSessionConfirmation &&
    !isNewSessionMode &&
    hasFollowUpContent({
      message,
      conflictMarkdown,
      reviewMarkdown,
      imageCount,
    })
  );
}

export function canCompactContext({
  hasSession,
  hasWorkspace,
  hasExecutor,
  canType,
  isAttemptRunning,
  isAwaitingNewSessionConfirmation,
  isNewSessionMode,
}: {
  hasSession: boolean;
  hasWorkspace: boolean;
  hasExecutor: boolean;
  canType: boolean;
  isAttemptRunning: boolean;
  isAwaitingNewSessionConfirmation: boolean;
  isNewSessionMode: boolean;
}): boolean {
  return (
    hasSession &&
    hasWorkspace &&
    hasExecutor &&
    canType &&
    !isAttemptRunning &&
    !isAwaitingNewSessionConfirmation &&
    !isNewSessionMode
  );
}

export function getSubmitShortcutAction({
  isAttemptRunning,
}: {
  isAttemptRunning: boolean;
  isQueued: boolean;
}): SubmitShortcutAction {
  if (!isAttemptRunning) return 'send';
  return 'queue';
}

export function buildQueuedFollowUp({
  message,
  conflictMarkdown,
  reviewMarkdown,
  images,
  executorProfile,
}: {
  message: string;
  conflictMarkdown: string | null | undefined;
  reviewMarkdown: string | null | undefined;
  images: string[];
  executorProfile: ExecutorProfileId | null;
}): {
  message: string;
  displayMessage: string;
  images: string[];
  executorProfile: ExecutorProfileId;
  pluginActions: SessionComposerPluginActionInvocation[];
} | null {
  if (!executorProfile) return null;
  if (
    !hasFollowUpContent({
      message,
      conflictMarkdown,
      reviewMarkdown,
      imageCount: images.length,
    })
  ) {
    return null;
  }

  const { prompt } = buildAgentPrompt(
    serializeSessionComposerBackendMessage(message),
    [conflictMarkdown, reviewMarkdown].filter(Boolean)
  );
  const { prompt: displayMessage } = buildAgentPrompt(message.trim(), [
    conflictMarkdown,
    reviewMarkdown,
  ]);

  return {
    message: prompt,
    displayMessage,
    images,
    executorProfile,
    pluginActions: getSessionComposerPluginActionInvocations(message),
  };
}

export function getAfterSendCleanup({
  attachments,
  scratchId,
  savedRevision,
  serverRevision,
}: {
  attachments: SessionComposerImageAttachment[];
  scratchId: string | undefined;
  savedRevision?: number | null;
  serverRevision?: number | null;
}): {
  message: string;
  attachments: SessionComposerImageAttachment[];
  imagesToRevoke: SessionComposerImageAttachment[];
  hydratedScratchId: string | undefined;
  shouldDeleteScratch: boolean;
} {
  const clearedImages = clearComposerImageAttachments(attachments);
  const remoteDraftIsNewer =
    savedRevision != null &&
    serverRevision != null &&
    serverRevision > savedRevision;

  return {
    message: '',
    attachments: clearedImages.attachments,
    imagesToRevoke: clearedImages.imagesToRevoke,
    hydratedScratchId: scratchId,
    shouldDeleteScratch: Boolean(scratchId) && !remoteDraftIsNewer,
  };
}
