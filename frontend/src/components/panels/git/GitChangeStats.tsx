import { memo } from 'react';

interface GitChangeStatsProps {
  additions: number;
  deletions: number;
  className?: string;
}

export const GitChangeStats = memo(function GitChangeStats({
  additions,
  deletions,
  className = '',
}: GitChangeStatsProps) {
  const hasAdditions = additions > 0;
  const hasDeletions = deletions > 0;

  return (
    <span
      className={`inline-flex min-w-8 shrink-0 items-center justify-end gap-0.5 font-mono tabular-nums text-[11px] leading-none ${className}`}
    >
      {hasAdditions && <span className="text-green-500">+{additions}</span>}
      {hasAdditions && hasDeletions && (
        <span className="text-muted-foreground">/</span>
      )}
      {hasDeletions && <span className="text-red-500">-{deletions}</span>}
      {!hasAdditions && !hasDeletions && (
        <span className="text-muted-foreground/40">--</span>
      )}
    </span>
  );
});
