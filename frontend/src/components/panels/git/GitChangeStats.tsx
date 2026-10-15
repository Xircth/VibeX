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
      data-testid="git-change-stats"
      className={`inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 font-mono text-[10px] leading-none tabular-nums ${className}`}
    >
      {hasAdditions && (
        <span className="text-[hsl(var(--success))]">+{additions}</span>
      )}
      {hasDeletions && (
        <span className="text-[hsl(var(--destructive))]">-{deletions}</span>
      )}
      {!hasAdditions && !hasDeletions && (
        <span className="text-muted-foreground/50">+0 -0</span>
      )}
    </span>
  );
});
