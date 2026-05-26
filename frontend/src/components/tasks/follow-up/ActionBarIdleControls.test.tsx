import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarIdleControls } from './ActionBarIdleControls';

const CLEAR_REVIEW_LABEL = '\u6e05\u9664\u5ba1\u67e5';
const SEND_LABEL = '\u53d1\u9001';
const RESOLVE_CONFLICT_LABEL = '\u89e3\u51b3\u51b2\u7a81';

function renderIdleControls(
  props: Partial<Parameters<typeof ActionBarIdleControls>[0]> = {}
) {
  return render(
    <ActionBarIdleControls
      isEditable={true}
      isAwaitingNewSessionConfirmation={false}
      isSendingFollowUp={false}
      canSendFollowUp={true}
      hasComments={false}
      hasConflictResolutionInstructions={false}
      onSendFollowUp={vi.fn()}
      onClearComments={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBarIdleControls', () => {
  it('clears review comments when comments are present', () => {
    const onClearComments = vi.fn();
    renderIdleControls({ hasComments: true, onClearComments });

    fireEvent.click(screen.getByRole('button', { name: CLEAR_REVIEW_LABEL }));

    expect(onClearComments).toHaveBeenCalledTimes(1);
  });

  it('hides clear review when there are no comments', () => {
    renderIdleControls({ hasComments: false });

    expect(
      screen.queryByRole('button', { name: CLEAR_REVIEW_LABEL })
    ).toBeNull();
  });

  it('disables clear review when the composer is not editable', () => {
    const onClearComments = vi.fn();
    renderIdleControls({
      isEditable: false,
      hasComments: true,
      onClearComments,
    });

    const clearButton = screen.getByRole('button', {
      name: CLEAR_REVIEW_LABEL,
    });
    expect(clearButton).toBeDisabled();

    fireEvent.click(clearButton);
    expect(onClearComments).not.toHaveBeenCalled();
  });

  it('sends follow-up when enabled', () => {
    const onSendFollowUp = vi.fn();
    renderIdleControls({ onSendFollowUp });

    fireEvent.click(screen.getByRole('button', { name: SEND_LABEL }));

    expect(onSendFollowUp).toHaveBeenCalledTimes(1);
  });

  it('disables send while unavailable, readonly, or awaiting confirmation', () => {
    [
      { canSendFollowUp: false },
      { isEditable: false },
      { isAwaitingNewSessionConfirmation: true },
    ].forEach((props) => {
      const onSendFollowUp = vi.fn();
      const { unmount } = renderIdleControls({
        onSendFollowUp,
        ...props,
      });

      const sendButton = screen.getByRole('button', { name: SEND_LABEL });
      expect(sendButton).toBeDisabled();

      fireEvent.click(sendButton);
      expect(onSendFollowUp).not.toHaveBeenCalled();

      unmount();
    });
  });

  it('uses conflict label and keeps it while sending', () => {
    const { rerender } = renderIdleControls({
      hasConflictResolutionInstructions: true,
    });

    expect(
      screen.getByRole('button', { name: RESOLVE_CONFLICT_LABEL })
    ).toBeInTheDocument();

    rerender(
      <ActionBarIdleControls
        isEditable={true}
        isAwaitingNewSessionConfirmation={false}
        isSendingFollowUp={true}
        canSendFollowUp={true}
        hasComments={false}
        hasConflictResolutionInstructions={true}
        onSendFollowUp={vi.fn()}
        onClearComments={vi.fn()}
      />
    );

    const sendButton = screen.getByRole('button', {
      name: RESOLVE_CONFLICT_LABEL,
    });
    expect(sendButton.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
