import type { TurnRenderItem } from './messageTurnBlocks';
import {
  MAX_TURN_ELAPSED_MS,
  plausibleTurnStartMs,
} from '@/components/conversation-thread/turnClock';

export function formatCollapsedDurationParts(durationMs: number): {
  hours: number;
  minutes: number;
} {
  const floored = Math.floor(durationMs / 60000);
  const totalMinutes = floored <= 0 ? 1 : floored;
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

function finiteDuration(
  value: number | bigint | null | undefined
): number | null {
  if (typeof value === 'bigint') {
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function plausibleSpan(ms: number | null): number | null {
  if (ms === null || ms <= 0 || ms > MAX_TURN_ELAPSED_MS) return null;
  return ms;
}

function toolSpanMs(items: TurnRenderItem[]): number | null {
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const item of items) {
    if (item.kind !== 'tool' || !item.use) continue;
    for (const stamp of [item.use.started_at, item.use.ended_at]) {
      const ms = plausibleTurnStartMs(stamp);
      if (ms === null) continue;
      earliest = earliest === null ? ms : Math.min(earliest, ms);
      latest = latest === null ? ms : Math.max(latest, ms);
    }
  }
  if (earliest === null || latest === null) return null;
  return plausibleSpan(latest - earliest);
}

/**
 * Wall-clock span of a folded process group.
 * Tool start/end stamps win. A settled turn's own duration is the fallback
 * when those stamps were never recorded. A missing span stays missing.
 */
export function collapsedMessagesDurationMs(input: {
  items: TurnRenderItem[];
  turnTimestamp?: string | null;
  completedAt?: string | null;
  durationMs?: number | bigint | null;
  settled: boolean;
}): number | null {
  const fromTools = toolSpanMs(input.items);
  if (fromTools !== null) return fromTools;
  if (!input.settled) return null;

  const recorded = plausibleSpan(finiteDuration(input.durationMs));
  if (recorded !== null) return recorded;

  const start = plausibleTurnStartMs(input.turnTimestamp);
  const end = plausibleTurnStartMs(input.completedAt);
  if (start === null || end === null) return null;
  return plausibleSpan(end - start);
}
