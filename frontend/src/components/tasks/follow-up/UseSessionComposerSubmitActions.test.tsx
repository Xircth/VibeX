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
  isEditingQueued = false,
}: Partial<Parameters<typeof useSessionComposerSubmitActions>[0]> = {}) {
  const clearStopping = vi.fn();
  const cancelDebouncedSave = vi.fn();
  const saveToScratch = vi.fn().mockResolvedValue(undefined);
  const queueMessage = vi.fn().mockResolvedValue(undefined);
  const onSubmitFollowUp = vi.fn();
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
      isEditingQueued,
      clearStopping,
      cancelDebouncedSave,
      saveToScratch,
      queueMessage,
      onAfterQueueCleanup,
      onSubmitFollowUp,
    })
  );

  return {
    ...result,
    clearStopping,
    cancelDebouncedSave,
    saveToScratch,
    queueMessage,
    onAfterQueueCleanup,
    onSubmitFollowUp,
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
      ['vibe://image'],
      [],
      'conflicts\n\nreview\n\ncontinue'
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

  it('sends the current Composer frame when no attempt is running', () => {
    const { result, onSubmitFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: false,
    });

    act(() => {
      result.current.handleComposerSubmit('current composer text');
    });

    expect(onSubmitFollowUp).toHaveBeenCalledWith('current composer text');
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it('queues the current Composer frame while an attempt is running', async () => {
    const { result, onSubmitFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: true,
      isQueued: false,
    });

    act(() => {
      result.current.handleComposerSubmit('current composer text');
    });

    expect(onSubmitFollowUp).not.toHaveBeenCalled();
    await waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
  });

  it('queues another durable input while a turn is running even if a queue already exists', async () => {
    const { result, onSubmitFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: true,
      isQueued: true,
    });

    act(() => {
      result.current.handleComposerSubmit('current composer text');
    });

    expect(onSubmitFollowUp).not.toHaveBeenCalled();
    await waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
  });

  it('updates the queued item being edited after the current turn ends', async () => {
    const { result, onSubmitFollowUp, queueMessage } = renderSubmitActions({
      isAttemptRunning: false,
      isQueued: false,
      isEditingQueued: true,
    });

    act(() => {
      result.current.handleComposerSubmit('edited queued text');
    });

    expect(onSubmitFollowUp).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(queueMessage).toHaveBeenCalledWith(
        'conflicts\n\nreview\n\nedited queued text',
        profile,
        ['vibe://image'],
        [],
        'conflicts\n\nreview\n\nedited queued text'
      )
    );
  });
});
