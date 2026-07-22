import { describe, expect, it } from 'vitest';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import {
  buildQueuedFollowUp,
  canCompactContext,
  canEditFollowUp,
  canSendFollowUp,
  canTypeFollowUp,
  getAfterSendCleanup,
  isComposerExecutionActive,
  hasPendingToolApproval,
  getSubmitShortcutAction,
  hasFollowUpContent,
} from './sessionComposerSubmit';

const profile = { executor: 'codex' as const };

describe('session composer submit helpers', () => {
  it('detects follow-up content from text, context, or images', () => {
    expect(
      hasFollowUpContent({
        message: '   ',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
    expect(
      hasFollowUpContent({
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(true);
    expect(
      hasFollowUpContent({
        message: '',
        conflictMarkdown: 'resolve conflicts',
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(true);
    expect(
      hasFollowUpContent({
        message: '',
        conflictMarkdown: null,
        reviewMarkdown: 'review notes',
        imageCount: 0,
      })
    ).toBe(true);
    expect(
      hasFollowUpContent({
        message: '',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 1,
      })
    ).toBe(true);
  });

  it('applies typing gates consistently', () => {
    expect(
      canTypeFollowUp({
        hasWorkspace: true,
        isSendingFollowUp: false,
        isRetryActive: false,
        hasPendingApproval: false,
        isCompactingContext: false,
      })
    ).toBe(true);

    for (const blocked of [
      { hasWorkspace: false },
      { isSendingFollowUp: true },
      { isRetryActive: true },
      { hasPendingApproval: true },
      { isCompactingContext: true },
    ]) {
      expect(
        canTypeFollowUp({
          hasWorkspace: true,
          isSendingFollowUp: false,
          isRetryActive: false,
          hasPendingApproval: false,
          isCompactingContext: false,
          ...blocked,
        })
      ).toBe(false);
    }
  });

  it('applies editability gates consistently', () => {
    expect(
      canEditFollowUp({
        isRetryActive: false,
        hasPendingApproval: false,
      })
    ).toBe(true);

    expect(
      canEditFollowUp({
        isRetryActive: true,
        hasPendingApproval: false,
      })
    ).toBe(false);

    expect(
      canEditFollowUp({
        isRetryActive: false,
        hasPendingApproval: true,
      })
    ).toBe(false);
  });

  it('detects pending tool approvals from normalized entries only', () => {
    expect(
      hasPendingToolApproval([
        {
          type: 'NORMALIZED_ENTRY',
          content: {
            entry_type: {
              type: 'tool_use',
              status: { status: 'pending_approval' },
            },
          },
        },
      ])
    ).toBe(true);

    expect(
      hasPendingToolApproval([
        {
          type: 'NORMALIZED_ENTRY',
          content: {
            entry_type: {
              type: 'tool_use',
              status: { status: 'completed' },
            },
          },
        },
        {
          type: 'NORMALIZED_ENTRY',
          content: {
            entry_type: {
              type: 'assistant_message',
              status: { status: 'pending_approval' },
            },
          },
        },
        {
          type: 'RAW_ENTRY',
          content: {
            entry_type: {
              type: 'tool_use',
              status: { status: 'pending_approval' },
            },
          },
        },
      ])
    ).toBe(false);
  });

  it('applies send eligibility gates and content requirements', () => {
    expect(
      canSendFollowUp({
        canType: true,
        hasExecutor: true,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(true);

    expect(
      canSendFollowUp({
        canType: true,
        hasExecutor: true,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
        message: '',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
    expect(
      canSendFollowUp({
        canType: false,
        hasExecutor: true,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
    expect(
      canSendFollowUp({
        canType: true,
        hasExecutor: false,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
    expect(
      canSendFollowUp({
        canType: true,
        hasExecutor: true,
        isAwaitingNewSessionConfirmation: true,
        isNewSessionMode: false,
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
    expect(
      canSendFollowUp({
        canType: true,
        hasExecutor: true,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: true,
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        imageCount: 0,
      })
    ).toBe(false);
  });

  it('applies compact eligibility gates', () => {
    expect(
      canCompactContext({
        hasSession: true,
        hasWorkspace: true,
        hasExecutor: true,
        canType: true,
        isAttemptRunning: false,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
      })
    ).toBe(true);

    expect(
      canCompactContext({
        hasSession: true,
        hasWorkspace: true,
        hasExecutor: true,
        canType: true,
        isAttemptRunning: true,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
      })
    ).toBe(false);
    expect(
      canCompactContext({
        hasSession: false,
        hasWorkspace: true,
        hasExecutor: true,
        canType: true,
        isAttemptRunning: false,
        isAwaitingNewSessionConfirmation: false,
        isNewSessionMode: false,
      })
    ).toBe(false);
  });

  it('selects the submit shortcut side effect without duplicating queued work', () => {
    expect(
      getSubmitShortcutAction({ isAttemptRunning: false, isQueued: false })
    ).toBe('send');
    expect(
      getSubmitShortcutAction({ isAttemptRunning: true, isQueued: false })
    ).toBe('queue');
    expect(
      getSubmitShortcutAction({ isAttemptRunning: true, isQueued: true })
    ).toBe('none');
  });

  it('treats a streaming canonical turn as active while legacy process state lags', () => {
    expect(
      isComposerExecutionActive({
        isAttemptRunning: false,
        isConversationTurnInFlight: true,
      })
    ).toBe(true);
  });

  it('builds queued follow-up requests with context and images', () => {
    expect(
      buildQueuedFollowUp({
        message: 'continue',
        conflictMarkdown: 'conflicts',
        reviewMarkdown: 'review',
        images: ['vibe://image-1'],
        executorProfile: profile,
      })
    ).toEqual({
      message: 'conflicts\n\nreview\n\ncontinue',
      images: ['vibe://image-1'],
      executorProfile: profile,
    });

    expect(
      buildQueuedFollowUp({
        message: '/status',
        conflictMarkdown: 'ignored',
        reviewMarkdown: 'ignored',
        images: [],
        executorProfile: profile,
      })
    ).toEqual({
      message: '/status',
      images: [],
      executorProfile: profile,
    });

    expect(
      buildQueuedFollowUp({
        message: '',
        conflictMarkdown: null,
        reviewMarkdown: '',
        images: [],
        executorProfile: profile,
      })
    ).toBeNull();
    expect(
      buildQueuedFollowUp({
        message: 'continue',
        conflictMarkdown: null,
        reviewMarkdown: '',
        images: [],
        executorProfile: null,
      })
    ).toBeNull();
  });

  it('serializes file reference components before queueing backend text', () => {
    const fileCommand = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });

    expect(
      buildQueuedFollowUp({
        message: `Review ${fileCommand} with $plan`,
        conflictMarkdown: null,
        reviewMarkdown: '',
        images: [],
        executorProfile: profile,
      })
    ).toEqual({
      message: 'Review src/App.tsx with $plan',
      images: [],
      executorProfile: profile,
    });
  });

  it('derives after-send cleanup state without hiding side effects', () => {
    const image = {
      id: 'image-1',
      name: 'image.png',
      path: 'vibe://image-1',
      previewUrl: 'blob:image-1',
    };

    expect(
      getAfterSendCleanup({
        attachments: [image],
        scratchId: 'session-1',
      })
    ).toEqual({
      message: '',
      attachments: [],
      imagesToRevoke: [image],
      hydratedScratchId: 'session-1',
      shouldDeleteScratch: true,
    });

    expect(
      getAfterSendCleanup({
        attachments: [],
        scratchId: undefined,
      })
    ).toEqual({
      message: '',
      attachments: [],
      imagesToRevoke: [],
      hydratedScratchId: undefined,
      shouldDeleteScratch: false,
    });
  });
});
