import { describe, expect, it, vi } from 'vitest';
import type { ConversationSteeringReceipt } from 'shared/types';
import {
  executeComposerSteer,
  getComposerSteeringTarget,
  getQueueSteerChannel,
  resolveQueuePromoteSteeringTarget,
} from './sessionComposerSteering';

const MESSAGES = {
  pluginBlocked:
    'Plugin actions cannot run as in-turn steering. Queue them instead.',
  imagesBlocked: 'The read channel cannot carry images. Queue them instead.',
  turnEnded:
    'The current turn has already finished. Your draft was kept so you can send it as a new turn.',
  unknown:
    'Steering status is unknown; the message was kept to avoid sending it twice.',
  rejected: 'The Agent did not accept in-turn steering.',
};

describe('getComposerSteeringTarget', () => {
  it('returns native mode when native steering is available', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: 'turn-1',
      })
    ).toEqual({ turnId: 'turn-1', mode: 'native' });
  });

  it('returns interrupt_restart mode when a turn is in flight without native steering', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
      })
    ).toEqual({ turnId: 'turn-1', mode: 'interrupt_restart' });
  });

  it('stays null when the turn is idle or currentTurnId is absent', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: false,
        steeringSupported: true,
        currentTurnId: 'turn-1',
      })
    ).toBeNull();
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: null,
      })
    ).toBeNull();
  });
});

describe('getQueueSteerChannel', () => {
  it('prefers native steering while a turn is in flight', () => {
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: 'turn-1',
        deliveryChannel: 'pull',
        sessionEnhanceFeedbackOn: true,
      })
    ).toBe('native');
  });

  it('uses pull when session enhance injected check_user_feedback and falls back to interrupt_restart otherwise', () => {
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
        deliveryChannel: 'pull',
        sessionEnhanceFeedbackOn: true,
      })
    ).toBe('pull');
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
        deliveryChannel: 'pull',
        sessionEnhanceFeedbackOn: false,
      })
    ).toBe('interrupt_restart');
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
        deliveryChannel: 'none',
        sessionEnhanceFeedbackOn: true,
      })
    ).toBe('interrupt_restart');
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: null,
        deliveryChannel: 'none',
        sessionEnhanceFeedbackOn: false,
      })
    ).toBeNull();
    expect(
      getQueueSteerChannel({
        isTurnInFlight: false,
        steeringSupported: false,
        currentTurnId: 'turn-1',
        deliveryChannel: 'pull',
        sessionEnhanceFeedbackOn: true,
      })
    ).toBeNull();
  });
});

describe('resolveQueuePromoteSteeringTarget', () => {
  it('upgrades plugin-action or image queued messages on pull/native channels to interrupt_restart', () => {
    expect(
      resolveQueuePromoteSteeringTarget({
        queueSteerChannel: 'native',
        steeringTarget: { turnId: 'turn-1', mode: 'native' },
        followUp: {
          message: 'Run workflow',
          images: [],
          pluginActions: [{ pluginId: 'plugin', actionId: 'act' }],
        },
      })
    ).toEqual({ turnId: 'turn-1', mode: 'interrupt_restart' });

    expect(
      resolveQueuePromoteSteeringTarget({
        queueSteerChannel: 'pull',
        steeringTarget: { turnId: 'turn-1', mode: 'interrupt_restart' },
        followUp: {
          message: 'Inspect image',
          images: ['.vibe-images/shot.png'],
          pluginActions: [],
        },
      })
    ).toEqual({ turnId: 'turn-1', mode: 'interrupt_restart' });

    expect(
      resolveQueuePromoteSteeringTarget({
        queueSteerChannel: 'pull',
        steeringTarget: { turnId: 'turn-1', mode: 'interrupt_restart' },
        followUp: {
          message: 'Text note',
          images: [],
          pluginActions: [],
        },
      })
    ).toBeNull();
  });
});

describe('executeComposerSteer', () => {
  it('rejects plugin actions on native steering with a toast and keeps the draft', async () => {
    const steer = vi.fn();
    const submitFeedback = vi.fn();
    const onAfterSuccess = vi.fn();
    const onRestoreDraft = vi.fn();
    const onError = vi.fn();
    const onToastError = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: '[!:plugin/act|Run](Run)',
      followUp: {
        message: 'Run',
        images: [],
        pluginActions: [
          {
            pluginId: 'plugin',
            actionId: 'act',
          },
        ],
      },
      steeringTarget: { turnId: 'turn-1', mode: 'native' },
      steer,
      submitFeedback,
      onAfterSuccess,
      onRestoreDraft,
      onError,
      onToastError,
      messages: MESSAGES,
    });

    expect(onToastError).toHaveBeenCalledWith(MESSAGES.pluginBlocked);
    expect(steer).not.toHaveBeenCalled();
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(onAfterSuccess).not.toHaveBeenCalled();
  });

  it('allows images and plugin actions in interrupt_restart mode and marks atomic queue consumption', async () => {
    const atomicReceipt = {
      status: 'accepted',
      deliveryMode: 'interrupt_restart',
      restartedTurnId: 'turn-2',
    } as unknown as ConversationSteeringReceipt;
    const steer = vi.fn().mockResolvedValue(atomicReceipt);
    const submitFeedback = vi.fn();
    const onAfterSuccess = vi.fn();
    const onRestoreDraft = vi.fn();
    const onError = vi.fn();
    const onToastError = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: 'Restart with workflow + image',
      followUp: {
        message: 'Restart with workflow + image',
        images: ['.vibe-images/shot.png'],
        pluginActions: [{ pluginId: 'plugin', actionId: 'act' }],
      },
      steeringTarget: { turnId: 'turn-1', mode: 'interrupt_restart' },
      promotedInputId: 'input-3',
      expectedRevision: 4,
      steer,
      submitFeedback,
      onAfterSuccess,
      onRestoreDraft,
      onError,
      onToastError,
      messages: MESSAGES,
    });

    expect(onToastError).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      expectedTurnId: 'turn-1',
      text: 'Restart with workflow + image',
      images: ['.vibe-images/shot.png'],
      promotedInputId: 'input-3',
      expectedRevision: 4,
      allowInterruptRestart: true,
    });
    expect(onAfterSuccess).toHaveBeenCalledWith({
      consumedPromotedInputAtomically: true,
      receipt: atomicReceipt,
    });
  });

  it('forwards displayText, fileRefs, modeOverride, and configOverrides when steering a queued message', async () => {
    const receipt = {
      status: 'accepted',
      deliveryMode: 'native',
    } as unknown as ConversationSteeringReceipt;
    const steer = vi.fn().mockResolvedValue(receipt);

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: '[@:App.tsx](src/App.tsx) focus here',
      followUp: {
        message: 'src/App.tsx focus here',
        displayText: '[@:App.tsx](src/App.tsx) focus here',
        images: [],
        pluginActions: [],
        fileRefs: [{ path: 'src/App.tsx' }],
        modeOverride: 'plan',
        configOverrides: [{ key: 'effort', value: 'high' }],
      },
      steeringTarget: { turnId: 'turn-1', mode: 'native' },
      promotedInputId: 'input-9',
      expectedRevision: 2,
      steer,
      submitFeedback: vi.fn(),
      onAfterSuccess: vi.fn(),
      onRestoreDraft: vi.fn(),
      onError: vi.fn(),
      onToastError: vi.fn(),
      messages: MESSAGES,
    });

    expect(steer).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      expectedTurnId: 'turn-1',
      text: 'src/App.tsx focus here',
      displayText: '[@:App.tsx](src/App.tsx) focus here',
      images: [],
      fileRefs: [{ path: 'src/App.tsx' }],
      modeOverride: 'plan',
      configOverrides: [{ key: 'effort', value: 'high' }],
      promotedInputId: 'input-9',
      expectedRevision: 2,
    });
  });

  it('falls back to non-atomic consumption when legacy backend receipt omits deliveryMode', async () => {
    const legacyReceipt = {
      status: 'accepted',
    } as ConversationSteeringReceipt;
    const steer = vi.fn().mockResolvedValue(legacyReceipt);
    const onAfterSuccess = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: 'Promote legacy',
      followUp: {
        message: 'Promote legacy',
        images: [],
        pluginActions: [],
      },
      steeringTarget: { turnId: 'turn-1', mode: 'native' },
      promotedInputId: 'input-2',
      expectedRevision: 1,
      steer,
      submitFeedback: vi.fn(),
      onAfterSuccess,
      onRestoreDraft: vi.fn(),
      onError: vi.fn(),
      onToastError: vi.fn(),
      messages: MESSAGES,
    });

    expect(onAfterSuccess).toHaveBeenCalledWith({
      consumedPromotedInputAtomically: false,
      receipt: legacyReceipt,
    });
  });

  it('rejects images on the pull feedback channel with a toast and keeps the draft', async () => {
    const steer = vi.fn();
    const submitFeedback = vi.fn();
    const onAfterSuccess = vi.fn();
    const onRestoreDraft = vi.fn();
    const onError = vi.fn();
    const onToastError = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: 'Check this screenshot',
      followUp: {
        message: 'Check this screenshot',
        images: ['.vibe-images/shot.png'],
        pluginActions: [],
      },
      steeringTarget: null,
      steer,
      submitFeedback,
      onAfterSuccess,
      onRestoreDraft,
      onError,
      onToastError,
      messages: MESSAGES,
    });

    expect(onToastError).toHaveBeenCalledWith(MESSAGES.imagesBlocked);
    expect(steer).not.toHaveBeenCalled();
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(onAfterSuccess).not.toHaveBeenCalled();
  });

  it('restores the draft and reports turn ended when receipt code is no_running_turn', async () => {
    const steer = vi.fn().mockResolvedValue({
      status: 'rejected',
      code: 'no_running_turn',
      message: 'Turn already finished',
    });
    const submitFeedback = vi.fn();
    const onAfterSuccess = vi.fn();
    const onRestoreDraft = vi.fn();
    const onError = vi.fn();
    const onToastError = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: 'Focus on the edge case',
      followUp: {
        message: 'Focus on the edge case',
        images: [],
        pluginActions: [],
      },
      steeringTarget: { turnId: 'turn-1', mode: 'native' },
      steer,
      submitFeedback,
      onAfterSuccess,
      onRestoreDraft,
      onError,
      onToastError,
      messages: MESSAGES,
    });

    expect(onRestoreDraft).toHaveBeenCalledWith('Focus on the edge case');
    expect(onToastError).toHaveBeenCalledWith(MESSAGES.turnEnded);
    expect(onError).toHaveBeenLastCalledWith(MESSAGES.turnEnded);
    expect(onAfterSuccess).not.toHaveBeenCalled();
  });

  it('restores the draft and reports turn ended when the backend throws no active turn', async () => {
    const steer = vi.fn();
    const submitFeedback = vi
      .fn()
      .mockRejectedValue(new Error('No active turn for conversation'));
    const onAfterSuccess = vi.fn();
    const onRestoreDraft = vi.fn();
    const onError = vi.fn();
    const onToastError = vi.fn();

    await executeComposerSteer({
      sessionId: 'conv-1',
      previousDraft: 'Wait before committing',
      followUp: {
        message: 'Wait before committing',
        images: [],
        pluginActions: [],
      },
      steeringTarget: null,
      steer,
      submitFeedback,
      onAfterSuccess,
      onRestoreDraft,
      onError,
      onToastError,
      messages: MESSAGES,
    });

    expect(onRestoreDraft).toHaveBeenCalledWith('Wait before committing');
    expect(onToastError).toHaveBeenCalledWith(MESSAGES.turnEnded);
    expect(onError).toHaveBeenLastCalledWith(MESSAGES.turnEnded);
    expect(onAfterSuccess).not.toHaveBeenCalled();
  });
});
