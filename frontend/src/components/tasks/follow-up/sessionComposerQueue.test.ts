import { describe, expect, it } from 'vitest';
import type { ConversationInputView } from 'shared/types';
import {
  getAttachImageQueueSeed,
  getEditorChangeSideEffects,
  getQueueIndicatorState,
  getQueueSnapshot,
  getQueueStatusQueryKey,
  inputViewToQueuedMessage,
  type QueueStatus,
} from './sessionComposerQueue';

const input: ConversationInputView = {
  id: 'input-1',
  conversationId: 'session-1',
  operationId: 'operation-1',
  revision: 2n,
  sortKey: 1024n,
  status: 'queued',
  payload: {
    agentId: 'codex',
    workspaceId: 'workspace-1',
    executorProfileId: { executor: 'codex' },
    text: 'agent text',
    displayText: 'visible text',
    images: ['vibe://queued-a'],
  },
  principal: { kind: 'local_desktop' },
  claimToken: null,
  claimDeadline: null,
  turnId: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:01.000Z',
};

function queuedStatus(): Extract<QueueStatus, { status: 'queued' }> {
  return { status: 'queued', messages: [inputViewToQueuedMessage(input)] };
}

describe('durable session composer queue projection', () => {
  it('maps server input facts without inventing local identity or ordering', () => {
    expect(inputViewToQueuedMessage(input)).toMatchObject({
      id: 'input-1',
      session_id: 'session-1',
      revision: 2n,
      sortKey: 1024n,
      status: 'queued',
      data: {
        message: 'visible text',
        agentMessage: 'agent text',
        images: ['vibe://queued-a'],
      },
    });
  });

  it('derives compact visibility while preserving every queued message', () => {
    const status = queuedStatus();
    expect(getQueueSnapshot(status)).toEqual({
      isQueued: true,
      queuedMessage: status.messages[0],
    });
    expect(getQueueIndicatorState(status, true)).toEqual({
      isQueued: true,
      queuedMessages: status.messages,
    });
    expect(getQueueIndicatorState(status, false)).toEqual({
      isQueued: true,
      queuedMessages: status.messages,
    });
  });

  it('uses one backend projection key and keeps draft behavior local-only', () => {
    expect(getQueueStatusQueryKey('session-1')).toEqual([
      'conversation-inputs',
      'session-1',
    ]);
    expect(getAttachImageQueueSeed({ fallbackMessage: 'draft' })).toEqual({
      scratchMessage: 'draft',
    });
    expect(
      getEditorChangeSideEffects({
        queueStatus: queuedStatus(),
        hasFollowUpError: true,
      })
    ).toEqual({ shouldPersistDraft: false, shouldClearError: true });
  });
});
