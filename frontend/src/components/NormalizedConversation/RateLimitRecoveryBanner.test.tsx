import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTINUATION_PROMPT,
  RateLimitRecoveryBanner,
} from './RateLimitRecoveryBanner';

describe('RateLimitRecoveryBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when not rate-limited', () => {
    const { container } = render(
      <RateLimitRecoveryBanner
        conversationId="conv-1"
        rateLimit={{
          isRateLimited: false,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:34.000Z',
          autoResume: true,
        }}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders live tabular-nums countdown, toggles auto-resume, edits continuation prompt, and cancels wait', async () => {
    const onUpdateAutoResume = vi.fn().mockResolvedValue(undefined);
    const onCancelWait = vi.fn().mockResolvedValue(undefined);

    render(
      <RateLimitRecoveryBanner
        conversationId="conv-rate-1"
        rateLimit={{
          isRateLimited: true,
          engine: 'Codex',
          limitedAt: '2026-06-01T12:00:00.000Z',
          resetAt: '2026-06-01T12:12:34.000Z',
          autoResume: true,
        }}
        onUpdateAutoResume={onUpdateAutoResume}
        onCancelWait={onCancelWait}
      />
    );

    const titleEl = screen.getByTestId('rate-limit-banner-title');
    expect(titleEl).toHaveClass('tabular-nums');
    expect(titleEl).toHaveTextContent('Codex');
    expect(titleEl).toHaveTextContent('12:34');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(titleEl).toHaveTextContent('12:31');

    // Toggle auto-resume switch off
    const switchEl = screen.getByTestId('rate-limit-auto-resume-switch');
    expect(switchEl).toHaveAttribute('data-state', 'checked');
    await act(async () => {
      fireEvent.click(switchEl);
    });

    expect(switchEl).toHaveAttribute('data-state', 'unchecked');
    expect(onUpdateAutoResume).toHaveBeenCalledWith({
      conversationId: 'conv-rate-1',
      autoResume: false,
      continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
    });

    // Expand and edit continuation prompt
    fireEvent.click(screen.getByTestId('rate-limit-edit-prompt-toggle'));
    const promptInput = screen.getByTestId(
      'rate-limit-prompt-input'
    ) as HTMLInputElement;
    expect(promptInput.value).toBe(DEFAULT_CONTINUATION_PROMPT);

    fireEvent.change(promptInput, {
      target: { value: 'Continue from step 3 and run tests.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-save-prompt-btn'));
    });

    expect(onUpdateAutoResume).toHaveBeenLastCalledWith({
      conversationId: 'conv-rate-1',
      autoResume: false,
      continuationPrompt: 'Continue from step 3 and run tests.',
    });
    expect(screen.queryByTestId('rate-limit-prompt-editor')).toBeNull();

    // Cancel wait
    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-cancel-btn'));
    });
    expect(onCancelWait).toHaveBeenCalledWith('conv-rate-1');
  });
});
