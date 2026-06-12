import { useEffect, useMemo, useState } from 'react';
import { TurnStats, type TurnStatsProps } from './TurnStats';

export type LiveTurnStatsProps = Omit<TurnStatsProps, 'live' | 'stats'> & {
  stats?: TurnStatsProps['stats'];
  startedAt?: string | null;
};

function elapsedFrom(startedAt: string | null | undefined, nowMs: number) {
  if (!startedAt) return null;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;

  return Math.max(0, nowMs - startedAtMs);
}

export function LiveTurnStats({
  stats,
  startedAt,
  ...props
}: LiveTurnStatsProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const liveStats = useMemo(
    () => ({
      ...stats,
      elapsedMs: stats?.elapsedMs ?? elapsedFrom(startedAt, nowMs),
    }),
    [nowMs, startedAt, stats]
  );

  return <TurnStats {...props} stats={liveStats} live />;
}

