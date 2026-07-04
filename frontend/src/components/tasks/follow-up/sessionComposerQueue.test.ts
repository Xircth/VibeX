import { describe, expect, it } from 'vitest';
import {
  buildCancelQueueMutationInput,
  buildQueueMutationInput,
  getEditorChangeSideEffects,
  getAttachImageQueueSeed,
  getQueueIndicatorState,
  getQueueSnapshot,
  getQueueStatusQueryKey,
  getVisibleQueuedMessage,
  shouldRefreshQueueStatus,
  type QueueStatus,
} from './sessionComposerQueue';

const profile = { executor: 'codex' as const };

function queuedStatus({
  message = 'queued text',
  images = ['vibe://queued-a'],
}: {
  message?: string;
  images?: string[];
} = {}): Extract<QueueStatus, { status: 'queued' }> {
  return {
    status: 'queued',
    message: {
      session_id: 'session-1',
      created_at: '2026-05-25T00:00:00.000Z',
      updated_at: '2026-05-25T00:00:00.000Z',
      data: {
        message,
        images,
      },
    },
  };
}

describe('session composer queue helpers', () => {
  it('extracts a stable queue snapshot from status values', () => {
    expect(getQueueSnapshot(undefined)).toEqual({
      isQueued: false,
      queuedMessage: null,
    });
    expect(getQueueSnapshot({ status: 'empty' })).toEqual({
      isQueued: false,
      queuedMessage: null,
    });

    const status = queuedStatus();
    expect(getQueueSnapshot(status)).toEqual({
      isQueued: true,
      queuedMessage: status.message,
    });
  });

  it('shows queued messages only while an attempt is running', () => {
    const status = queuedStatus();

    expect(getVisibleQueuedMessage(status, true)).toBe(status.message);
    expect(getVisibleQueuedMessage(status, false)).toBeNull();
    expect(getVisibleQueuedMessage({ status: 'empty' }, true)).toBeNull();
  });

  it('derives queue indicator state only for visible queued messages', () => {
    const status = queuedStatus();
    expect(getQueueIndicatorState(queuedStatus(), true)).toEqual({
      isQueued: true,
      queuedMessage: status.message,
      messagePreview: 'queued text',
      attachmentCount: 1,
    });

    expect(getQueueIndicatorState(queuedStatus(), false)).toEqual({
      isQueued: false,
      queuedMessage: null,
      messagePreview: null,
      attachmentCount: 0,
    });

    expect(getQueueIndicatorState({ status: 'empty' }, true)).toEqual({
      isQueued: false,
      queuedMessage: null,
      messagePreview: null,
      attachmentCount: 0,
    });
  });

  it('derives image attachment seed data from the local draft only', () => {
    expect(
      getAttachImageQueueSeed({
        fallbackMessage: 'local draft',
      })
    ).toEqual({
      scratchMessage: 'local draft',
    });
  });

  it('keeps queue refresh policy tied to attempt/process changes', () => {
    expect(
      shouldRefreshQueueStatus({
        hasWorkspace: false,
        isAttemptRunning: false,
        previousProcessCount: 1,
        currentProcessCount: 1,
      })
    ).toBe(false);

    expect(
      shouldRefreshQueueStatus({
        hasWorkspace: true,
        isAttemptRunning: false,
        previousProcessCount: 1,
        currentProcessCount: 1,
      })
    ).toBe(true);

    expect(
      shouldRefreshQueueStatus({
        hasWorkspace: true,
        isAttemptRunning: true,
        previousProcessCount: 1,
        currentProcessCount: 2,
      })
    ).toBe(true);

    expect(
      shouldRefreshQueueStatus({
        hasWorkspace: true,
        isAttemptRunning: true,
        previousProcessCount: 2,
        currentProcessCount: 2,
      })
    ).toBe(false);
  });

  it('derives editor-change side effects from queue and error state', () => {
    expect(
      getEditorChangeSideEffects({
        queueStatus: queuedStatus(),
        hasFollowUpError: true,
      })
    ).toEqual({
      shouldPersistDraft: false,
      shouldClearError: true,
    });

    expect(
      getEditorChangeSideEffects({
        queueStatus: { status: 'empty' },
        hasFollowUpError: false,
      })
    ).toEqual({
      shouldPersistDraft: true,
      shouldClearError: false,
    });
  });

  it('builds queue query keys and mutation inputs only when a session exists', () => {
    expect(getQueueStatusQueryKey('session-1')).toEqual([
      'queue-status',
      'session-1',
    ]);
    expect(getQueueStatusQueryKey(undefined)).toEqual([
      'queue-status',
      undefined,
    ]);

    expect(
      buildQueueMutationInput({
        sessionId: 'session-1',
        message: 'queued text',
        images: ['vibe://image'],
        executorProfileId: profile,
      })
    ).toEqual({
      sessionId: 'session-1',
      message: 'queued text',
      images: ['vibe://image'],
      executorProfileId: profile,
    });
    expect(
      buildQueueMutationInput({
        sessionId: undefined,
        message: 'queued text',
        images: [],
        executorProfileId: profile,
      })
    ).toBeNull();

    expect(buildCancelQueueMutationInput('session-1')).toEqual({
      sessionId: 'session-1',
    });
    expect(buildCancelQueueMutationInput(undefined)).toBeNull();
  });
});
