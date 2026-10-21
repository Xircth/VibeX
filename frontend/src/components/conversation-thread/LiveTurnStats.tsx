import { useEffect, useMemo, useState } from 'react';
import { TurnStats, type TurnStatsProps } from './TurnStats';
import { liveElapsedMs } from './turnClock';

export type LiveTurnStatsProps = Omit<TurnStatsProps, 'live' | 'stats'> & {
  stats?: TurnStatsProps['stats'];
  startedAt?: string | null;
};

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
      elapsedMs: liveElapsedMs(startedAt, nowMs, stats?.elapsedMs),
    }),
    [nowMs, startedAt, stats]
  );

  return <TurnStats {...props} stats={liveStats} live />;
}
