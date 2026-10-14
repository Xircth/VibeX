import type { ConversationSteeringReceipt } from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';

export function getComposerSteeringTarget(args: {
  isTurnInFlight: boolean;
  steeringSupported: boolean;
  currentTurnId: string | null;
}): { turnId: string } | null {
  if (!args.isTurnInFlight || !args.steeringSupported || !args.currentTurnId) {
    return null;
  }
  return { turnId: args.currentTurnId };
}

export type ComposerSteerFollowUp = {
  message: string;
  images: string[];
  pluginActions: SessionComposerPluginActionInvocation[];
};

export type ExecuteComposerSteerArgs = {
  sessionId: string;
  previousDraft: string;
  followUp: ComposerSteerFollowUp;
  steeringTarget: { turnId: string } | null;
  steer: (args: {
    conversationId: string;
    expectedTurnId: string;
    text: string;
    images: string[];
  }) => Promise<ConversationSteeringReceipt>;
  submitFeedback: (args: {
    conversationId: string;
    text: string;
  }) => Promise<unknown>;
  onAfterSuccess: () => Promise<void> | void;
  onRestoreDraft: (draft: string) => void;
  onError: (message: string | null) => void;
  onToastError: (message: string) => void;
  messages: {
    pluginBlocked: string;
    imagesBlocked: string;
    turnEnded: string;
    unknown: string;
    rejected: string;
  };
};

export async function executeComposerSteer({
  sessionId,
  previousDraft,
  followUp,
  steeringTarget,
  steer,
  submitFeedback,
  onAfterSuccess,
  onRestoreDraft,
  onError,
  onToastError,
  messages,
}: ExecuteComposerSteerArgs): Promise<void> {
  if (followUp.pluginActions.length > 0) {
    onToastError(messages.pluginBlocked);
    return;
  }
  if (!steeringTarget && followUp.images.length > 0) {
    onToastError(messages.imagesBlocked);
    return;
  }

  onError(null);
  try {
    if (steeringTarget) {
      const receipt = await steer({
        conversationId: sessionId,
        expectedTurnId: steeringTarget.turnId,
        text: followUp.message,
        images: followUp.images,
      });
      if (receipt.status === 'accepted') {
        await onAfterSuccess();
        return;
      }
      if (receipt.code === 'no_running_turn') {
        onRestoreDraft(previousDraft);
        onToastError(messages.turnEnded);
        onError(messages.turnEnded);
        return;
      }
      onError(
        receipt.status === 'unknown'
          ? [messages.unknown, receipt.message].filter(Boolean).join(' ')
          : receipt.message || messages.rejected
      );
      return;
    }

    await submitFeedback({
      conversationId: sessionId,
      text: followUp.message,
    });
    await onAfterSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no active turn/i.test(message)) {
      onRestoreDraft(previousDraft);
      onToastError(messages.turnEnded);
      onError(messages.turnEnded);
      return;
    }
    onRestoreDraft(previousDraft);
    onError(message);
  }
}
