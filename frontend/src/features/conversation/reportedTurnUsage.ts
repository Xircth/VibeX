import type { TurnUsage } from 'shared/types';

function finiteCount(
  value: bigint | number | string | null | undefined
): number {
  if (typeof value === 'bigint') {
    const next = Number(value);
    return Number.isSafeInteger(next) ? next : 0;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const next = Number(value);
    return Number.isFinite(next) ? next : 0;
  }
  return 0;
}

/** Itemized token spend. All-zero usage is not a report. */
export function reportedProtocolSpend(
  usage: TurnUsage | null | undefined
): number | null {
  if (!usage) return null;
  const total =
    finiteCount(usage.input_tokens) +
    finiteCount(usage.output_tokens) +
    finiteCount(usage.cache_creation_input_tokens) +
    finiteCount(usage.cache_read_input_tokens);
  if (!Number.isFinite(total) || total <= 0) return null;
  return total;
}

/**
 * Keep a reported token breakdown when a later sample only carries context
 * occupancy. A sample with protocol spend replaces the buckets.
 */
export function mergeReportedTurnUsage(
  existing: TurnUsage | null | undefined,
  incoming: TurnUsage | null | undefined
): TurnUsage | null | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const base =
    reportedProtocolSpend(incoming) != null
      ? incoming
      : reportedProtocolSpend(existing) != null
        ? existing
        : incoming;
  return {
    ...base,
    context_used: incoming.context_used ?? existing.context_used,
    context_window_max:
      incoming.context_window_max ?? existing.context_window_max,
    cost_amount: incoming.cost_amount ?? existing.cost_amount,
    cost_currency: incoming.cost_currency ?? existing.cost_currency,
  };
}
