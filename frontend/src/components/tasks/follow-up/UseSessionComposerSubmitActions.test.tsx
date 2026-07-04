import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionComposerSubmitActions } from './useSessionComposerSubmitActions';

const profile = { executor: 'codex' as const };

function renderSubmitActions({
  localMessage = 'continue',
  conflictResolutionInstructions = 'conflicts',
  reviewMarkdown = 'review',
  attachedImagePaths = ['vibe://image'],
  effectiveExecutorProfile = profile,
  isAttemptRunning = false,
  isQueued = false,
}: Partial<Parameters<typeof useSessionComposerSubmitActions>[0]> = {}) {
  const clearStopping = vi.fn();
  const cancelDebouncedSave = vi.fn();
  const saveToScratch = vi.fn().mockResolvedValue(undefined);
  const queueMessage = vi.fn().mockResolvedValue(undefined);
  const onSendFollowUp = vi.fn();
  const onAfterQueueCleanup = vi.fn();

  const result = renderHook(() =>
    useSessionComposerSubmitActions({
      localMessage,
      conflictResolutionInstructions,
      reviewMarkdown,
      attachedImagePaths,
      effectiveExecutorProfile,
      isAttemptRunning,
      isQueued,
      clearStopping,
      cancelDebouncedSave,
      saveToScratch,
      queueMessage,
      onAfterQueueCleanup,
      onSendFollowUp,
    })
  );

  return {
    ...result,
    clearStopping,
    cancelDebouncedSave,
    saveToScratch,
    queueMessage,
    onAfterQueueCleanup,
    onSendFollowUp,
  };
}

describe('useSessionComposerSubmitActions', () => {
  it('queues valid follow-up payloads after clearing transient state and saving scratch', async () => {
    const {
      result,
      clearStopping,
      cancelDebouncedSave,
      saveToScratch,
      queueMessage,
      onAfterQueueCleanup,
    } = renderSubmitActions();

    await act(async () => {
      await result.current.handleQueueMessage();
    });

    expect(clearStopping).toHaveBeenCalledOnce();
    expect(cancelDebouncedSave).toHaveBeenCalledOnce();
    expect(saveToScratch).toHaveBeenCalledWith('continue', profile);
    expect(queueMessage).toHaveBeenCalledWith(
      'conflicts\n\nreview\n\ncontinue',
      profile,
      ['vibe://image']
    );
    expect(onAfterQueueCleanup).toHaveBeenCalledOnce();
  });

  it('suppresses queue side effects when no queued follow-up can be built', async () => {
    const {
      result,
      clearStopping,
      cancelDebouncedSave,
      saveToScratch,
      queueMessage,
      onAfterQueueCleanup,
    } = renderSubmitActions({
      localMessage: '',
      conflictResolutionInstructions: null,
      reviewMarkdown: '',
      attachedImagePaths: [],
      effectiveExecutorProfile: null,
    });

    await act(async () => {
      await result.current.handleQueueMessage();
    });

    expect(clearStopping).not.toHaveBeenCalled();
    expect(cancelDebouncedSave).not.toHaveBeenCalled();
    expect(saveToScratch).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(onAfterQueueCleanup).not.toHaveBeenCalled();
  });

  it('sends immediately from the submit shortcut when no attempt is running', () => {
    const { result, onSendFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: false,
    });
    const event = { preventDefault: vi.fn() } as unknown as KeyboardEvent;

    act(() => {
      result.current.handleSubmitShortcut(event);
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onSendFollowUp).toHaveBeenCalledOnce();
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it('queues from the submit shortcut while an attempt is running and no queued message exists', async () => {
    const { result, onSendFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: true,
      isQueued: false,
    });
    const event = { preventDefault: vi.fn() } as unknown as KeyboardEvent;

    act(() => {
      result.current.handleSubmitShortcut(event);
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onSendFollowUp).not.toHaveBeenCalled();
    await waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
  });

  it('does not duplicate queued work from the submit shortcut', () => {
    const { result, onSendFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: true,
      isQueued: true,
    });

    act(() => {
      result.current.handleSubmitShortcut();
    });

    expect(onSendFollowUp).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
