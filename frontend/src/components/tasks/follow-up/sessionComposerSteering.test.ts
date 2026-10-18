import { describe, expect, it, vi } from 'vitest';
import {
  executeComposerSteer,
  getComposerSteeringTarget,
  getQueueSteerChannel,
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
  it('returns the in-flight turn when native steering is available', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: 'turn-1',
      })
    ).toEqual({ turnId: 'turn-1' });
  });

  it('stays null when the turn is idle or steering is unsupported', () => {
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
        steeringSupported: false,
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

  it('offers pull only when session enhance injected check_user_feedback', () => {
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
    ).toBeNull();
    expect(
      getQueueSteerChannel({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
        deliveryChannel: 'none',
        sessionEnhanceFeedbackOn: true,
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

describe('executeComposerSteer', () => {
  it('rejects plugin actions with a toast and keeps the draft without enqueuing a new turn', async () => {
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
      steeringTarget: { turnId: 'turn-1' },
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
      steeringTarget: { turnId: 'turn-1' },
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
