import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineRow } from 'shared/types';
import {
  ConversationStatusProvider,
  useConversationStatus,
} from '@/contexts/ConversationStatusContext';
import { conversationApi } from '@/features/conversation/conversationApi';
import { RateLimitRecoveryBanner } from './RateLimitRecoveryBanner';
import {
  deriveRateLimitIndicatorState,
  useConversationRateLimitState,
} from './useConversationRateLimitState';

function Producer({ sideRows }: { sideRows: TimelineRow[] }) {
  const { setRateLimit } = useConversationStatus();
  const { rateLimit, handleUpdateAutoResume, handleCancelWait } =
    useConversationRateLimitState({
      sessionId: 'conv-rl-1',
      agentId: 'codex',
      sessionRecord: null,
      sideRows,
      latestTurnError: null,
    });

  useEffect(() => {
    if (rateLimit) {
      setRateLimit({
        conversationId: 'conv-rl-1',
        state: rateLimit,
        onUpdateAutoResume: handleUpdateAutoResume,
        onCancelWait: handleCancelWait,
      });
    } else {
      setRateLimit(null);
    }
  }, [handleCancelWait, handleUpdateAutoResume, rateLimit, setRateLimit]);

  return null;
}

function ComposerBannerConsumer() {
  const { rateLimit } = useConversationStatus();
  if (!rateLimit) return null;
  return (
    <RateLimitRecoveryBanner
      conversationId={rateLimit.conversationId}
      rateLimit={rateLimit.state}
      onUpdateAutoResume={rateLimit.onUpdateAutoResume}
      onCancelWait={rateLimit.onCancelWait}
    />
  );
}

describe('useConversationRateLimitState', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
    spies.push(spy);
    return spy;
  };

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('derives active rate-limit hold from retrying request_status and wires RateLimitRecoveryBanner via ConversationStatusContext', async () => {
    const updateSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'updateRateLimitAutoResume')
        .mockResolvedValue(undefined)
    );
    const cancelSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'cancelRateLimitWait')
        .mockResolvedValue(undefined)
    );

    const retryRows: TimelineRow[] = [
      {
        row_id: 'runtime-req-1',
        revision: 1n,
        row: {
          kind: 'session_notice',
          notice: {
            title: 'Retrying',
            severity: 'warning',
            request_status: {
              turn_id: 'turn-1',
              prompt_id: 'p-1',
              connection_id: 'c-1',
              since: new Date(Date.now()).toISOString(),
              activity: {
                phase: 'retrying',
                retry: {
                  attempt: 1,
                  max_attempts: 5,
                  delay_ms: 120_000n,
                  reason: 'HTTP 429 rate_limit exceeded',
                  code: 'rate_limited',
                },
              },
            },
          },
        },
      },
    ];

    const derived = deriveRateLimitIndicatorState({
      engineLabel: 'Codex',
      sessionRecord: null,
      sideRows: retryRows,
      latestTurnError: null,
    });
    expect(derived?.state.isRateLimited).toBe(true);
    expect(derived?.state.engine).toBe('Codex');

    render(
      <ConversationStatusProvider>
        <Producer sideRows={retryRows} />
        <ComposerBannerConsumer />
      </ConversationStatusProvider>
    );

    const banner = await screen.findByTestId('rate-limit-recovery-banner');
    expect(banner).toHaveTextContent('Codex');

    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-auto-resume-switch'));
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-rl-1',
        autoResume: false,
      })
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('rate-limit-cancel-btn'));
    });
    expect(cancelSpy).toHaveBeenCalledWith({ conversationId: 'conv-rl-1' });
    expect(screen.queryByTestId('rate-limit-recovery-banner')).toBeNull();
  });
});
