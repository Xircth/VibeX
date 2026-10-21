import { describe, expect, it } from 'vitest';
import type { TurnUsage } from 'shared/types';
import {
  mergeReportedTurnUsage,
  reportedProtocolSpend,
} from './reportedTurnUsage';

function usage(partial: Partial<TurnUsage> = {}): TurnUsage {
  return {
    input_tokens: 0n,
    output_tokens: 0n,
    cache_creation_input_tokens: 0n,
    cache_read_input_tokens: 0n,
    context_window_max: null,
    ...partial,
  };
}

describe('mergeReportedTurnUsage', () => {
  it('keeps protocol buckets when a later sample is only occupancy', () => {
    const existing = usage({
      input_tokens: 20n,
      output_tokens: 10n,
      cache_read_input_tokens: 70n,
    });
    const incoming = usage({
      context_used: 12_000n,
      context_window_max: 200_000n,
    });

    expect(reportedProtocolSpend(incoming)).toBeNull();
    expect(mergeReportedTurnUsage(existing, incoming)).toMatchObject({
      input_tokens: 20n,
      output_tokens: 10n,
      cache_read_input_tokens: 70n,
      context_used: 12_000n,
      context_window_max: 200_000n,
    });
  });

  it('replaces buckets when the incoming sample has spend', () => {
    const merged = mergeReportedTurnUsage(
      usage({ input_tokens: 1n, context_window_max: 128_000n }),
      usage({ input_tokens: 8n, output_tokens: 2n })
    );
    expect(merged).toMatchObject({
      input_tokens: 8n,
      output_tokens: 2n,
      context_window_max: 128_000n,
    });
  });
});
