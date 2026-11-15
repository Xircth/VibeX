import type {
  ConversationInputPayload,
  ConversationSteeringReceipt,
} from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';

export type ComposerSteeringMode = 'native' | 'interrupt_restart';

export type ComposerSteeringTarget = {
  turnId: string;
  mode: ComposerSteeringMode;
};

export function getComposerSteeringTarget(args: {
  isTurnInFlight: boolean;
  steeringSupported: boolean;
  currentTurnId: string | null;
}): ComposerSteeringTarget | null {
  if (!args.isTurnInFlight || !args.currentTurnId) {
    return null;
  }
  return {
    turnId: args.currentTurnId,
    mode: args.steeringSupported ? 'native' : 'interrupt_restart',
  };
}

export type ComposerSteerChannel = 'native' | 'pull' | 'interrupt_restart';

export function getQueueSteerChannel(args: {
  isTurnInFlight: boolean;
  steeringSupported: boolean;
  currentTurnId: string | null;
  deliveryChannel: 'native' | 'pull' | 'none' | null | undefined;
  sessionEnhanceFeedbackOn: boolean;
}): ComposerSteerChannel | null {
  if (!args.isTurnInFlight) return null;
  if (args.steeringSupported && args.currentTurnId) return 'native';
  if (args.deliveryChannel === 'pull' && args.sessionEnhanceFeedbackOn) {
    return 'pull';
  }
  if (args.currentTurnId) return 'interrupt_restart';
  return null;
}

export type ComposerSteerFollowUp = {
  message: string;
  displayText?: string;
  images: string[];
  pluginActions: SessionComposerPluginActionInvocation[];
  fileRefs?: ConversationInputPayload['fileRefs'];
  modeOverride?: ConversationInputPayload['modeOverride'];
  configOverrides?: ConversationInputPayload['configOverrides'];
};

export function resolveQueuePromoteSteeringTarget(args: {
  queueSteerChannel: ComposerSteerChannel | null;
  steeringTarget: { turnId: string; mode?: ComposerSteeringMode } | null;
  followUp: ComposerSteerFollowUp;
}): ComposerSteeringTarget | null {
  if (!args.queueSteerChannel) return null;
  if (args.queueSteerChannel === 'interrupt_restart') {
    return args.steeringTarget
      ? { turnId: args.steeringTarget.turnId, mode: 'interrupt_restart' }
      : null;
  }
  if (args.queueSteerChannel === 'native') {
    if (!args.steeringTarget) return null;
    if (args.followUp.pluginActions.length > 0) {
      return { turnId: args.steeringTarget.turnId, mode: 'interrupt_restart' };
    }
    return {
      turnId: args.steeringTarget.turnId,
      mode: args.steeringTarget.mode ?? 'native',
    };
  }
  if (
    args.steeringTarget &&
    (args.followUp.images.length > 0 || args.followUp.pluginActions.length > 0)
  ) {
    return { turnId: args.steeringTarget.turnId, mode: 'interrupt_restart' };
  }
  return null;
}

export function wasSteerPromotedAtomically(
  receipt: unknown,
  promotedInputId?: string
): boolean {
  if (!promotedInputId || !receipt || typeof receipt !== 'object') {
    return false;
  }
  const record = receipt as Record<string, unknown>;
  return (
    'deliveryMode' in record ||
    'delivery_mode' in record ||
    'restartedTurnId' in record ||
    'restarted_turn_id' in record
  );
}

export type ComposerSteerAfterSuccessMeta = {
  consumedPromotedInputAtomically: boolean;
  receipt?: ConversationSteeringReceipt;
};

export type ExecuteComposerSteerArgs = {
  sessionId: string;
  previousDraft: string;
  followUp: ComposerSteerFollowUp;
  steeringTarget: { turnId: string; mode?: ComposerSteeringMode } | null;
  promotedInputId?: string;
  expectedRevision?: number;
  allowInterruptRestart?: boolean;
  steer: (args: {
    conversationId: string;
    expectedTurnId: string;
    text: string;
    displayText?: string;
    images: string[];
    fileRefs?: ConversationInputPayload['fileRefs'];
    modeOverride?: ConversationInputPayload['modeOverride'];
    configOverrides?: ConversationInputPayload['configOverrides'];
    promotedInputId?: string;
    expectedRevision?: number;
    allowInterruptRestart?: boolean;
  }) => Promise<ConversationSteeringReceipt>;
  submitFeedback: (args: {
    conversationId: string;
    text: string;
  }) => Promise<unknown>;
  onAfterSuccess: (
    meta?: ComposerSteerAfterSuccessMeta
  ) => Promise<void> | void;
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
  promotedInputId,
  expectedRevision,
  allowInterruptRestart,
  steer,
  submitFeedback,
  onAfterSuccess,
  onRestoreDraft,
  onError,
  onToastError,
  messages,
}: ExecuteComposerSteerArgs): Promise<void> {
  const isInterruptRestart = steeringTarget?.mode === 'interrupt_restart';
  if (!isInterruptRestart && followUp.pluginActions.length > 0) {
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
      const effectiveAllowInterruptRestart =
        allowInterruptRestart ?? (isInterruptRestart ? true : undefined);
      const receipt = await steer({
        conversationId: sessionId,
        expectedTurnId: steeringTarget.turnId,
        text: followUp.message,
        ...(followUp.displayText !== undefined
          ? { displayText: followUp.displayText }
          : {}),
        images: followUp.images,
        ...(followUp.fileRefs && followUp.fileRefs.length > 0
          ? { fileRefs: followUp.fileRefs }
          : {}),
        ...(followUp.modeOverride != null
          ? { modeOverride: followUp.modeOverride }
          : {}),
        ...(followUp.configOverrides && followUp.configOverrides.length > 0
          ? { configOverrides: followUp.configOverrides }
          : {}),
        ...(promotedInputId ? { promotedInputId } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(effectiveAllowInterruptRestart !== undefined
          ? { allowInterruptRestart: effectiveAllowInterruptRestart }
          : {}),
      });
      if (receipt.status === 'accepted') {
        await onAfterSuccess({
          consumedPromotedInputAtomically: wasSteerPromotedAtomically(
            receipt,
            promotedInputId
          ),
          receipt,
        });
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
    await onAfterSuccess({ consumedPromotedInputAtomically: false });
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
