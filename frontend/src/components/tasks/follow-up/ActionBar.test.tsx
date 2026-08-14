import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBar } from './ActionBar';

function renderActionBar(props: Partial<Parameters<typeof ActionBar>[0]> = {}) {
  return render(
    <ActionBar
      profiles={null}
      effectiveExecutorProfile={null}
      onChangeExecutorProfile={vi.fn()}
      showProfileControls={false}
      isEditable={true}
      isAttemptRunning={false}
      isQueueLoading={false}
      canCompactContext={false}
      isCompactingContext={false}
      isStopping={false}
      isSendingFollowUp={false}
      canSendFollowUp={true}
      promptEnhancementEnabled={false}
      isEnhancingPrompt={false}
      canEnhancePrompt={false}
      sessionId="session-1"
      localMessage="Ship it"
      attachmentCount={0}
      conflictResolutionInstructions={null}
      reviewMarkdown={null}
      comments={[]}
      onCompactContext={vi.fn()}
      onQueueMessage={vi.fn()}
      onStopExecution={vi.fn()}
      onSendFollowUp={vi.fn()}
      onEnhancePrompt={vi.fn()}
      onClearComments={vi.fn()}
      onAttachImages={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBar', () => {
  it('does not keep a hidden duplicate todo trigger', () => {
    renderActionBar();

    expect(
      screen.queryByTitle('\u67e5\u770b\u5f85\u529e\u4e8b\u9879')
    ).not.toBeInTheDocument();
  });

  it('shows an arrow action that sends while the conversation is idle', () => {
    const onSendFollowUp = vi.fn();
    renderActionBar({ onSendFollowUp });

    const sendButton = screen.getByRole('button', { name: '\u53d1\u9001' });
    expect(sendButton.querySelector('.lucide-arrow-up')).toBeInTheDocument();
    expect(sendButton).not.toHaveTextContent('\u53d1\u9001');

    fireEvent.click(sendButton);

    expect(onSendFollowUp).toHaveBeenCalledTimes(1);
  });

  it('replaces the arrow with a square action that stops a running turn', () => {
    const onStopExecution = vi.fn();
    renderActionBar({ isAttemptRunning: true, onStopExecution });

    const stopButton = screen.getByRole('button', { name: '\u505c\u6b62' });
    expect(stopButton.querySelector('.lucide-square')).toBeInTheDocument();
    expect(stopButton).not.toHaveTextContent('\u505c\u6b62');

    fireEvent.click(stopButton);

    expect(onStopExecution).toHaveBeenCalledTimes(1);
  });

  it('groups attachment and utility actions immediately before send', () => {
    renderActionBar({ promptEnhancementEnabled: true });

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '附加图片',
      '压缩上下文',
      '提示词优化',
      '发送',
    ]);
  });

  it('uses context and attachments as queueable content while running', () => {
    const queueCases = [
      { conflictResolutionInstructions: 'conflicts', reviewMarkdown: null },
      { conflictResolutionInstructions: null, reviewMarkdown: 'review' },
      {
        conflictResolutionInstructions: null,
        reviewMarkdown: null,
        attachmentCount: 1,
      },
    ];

    queueCases.forEach((queueCase) => {
      const onQueueMessage = vi.fn();
      const { unmount } = renderActionBar({
        isAttemptRunning: true,
        localMessage: '   ',
        canSendFollowUp: false,
        onQueueMessage,
        ...queueCase,
      });

      fireEvent.click(screen.getByRole('button', { name: '\u961f\u5217' }));

      expect(onQueueMessage).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  it('disables queueing when a running attempt has no content', () => {
    const onQueueMessage = vi.fn();
    renderActionBar({
      isAttemptRunning: true,
      localMessage: '   ',
      canSendFollowUp: false,
      onQueueMessage,
    });

    const queueButton = screen.getByRole('button', { name: '\u961f\u5217' });
    expect(queueButton).toBeDisabled();

    fireEvent.click(queueButton);

    expect(onQueueMessage).not.toHaveBeenCalled();
  });
});
