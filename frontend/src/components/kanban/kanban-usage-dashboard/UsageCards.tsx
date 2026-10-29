import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

import { type ProjectUsageTokenCounts } from '@/lib/api';
import { cn } from '@/lib/utils';

import type { UsageHabitItem, UsageRankingItem } from './types';
import { formatOptionalCost, formatOptionalNumber } from './usageFormat';

export function UsageCardHeader({
  icon: Icon,
  title,
  right,
  description,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  right?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-3 shrink-0', className)}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>{title}</span>
        </h4>
        {right}
      </div>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
    </header>
  );
}

export function OverviewStat({
  label,
  value,
  detail,
  compact = false,
  valueClassName,
  valueTitle,
}: {
  label?: ReactNode;
  value: ReactNode;
  detail: ReactNode;
  compact?: boolean;
  valueClassName?: string;
  valueTitle?: string;
}) {
  return (
    <div className="min-w-0">
      {label ? (
        <span
          className={cn(
            'text-muted-foreground',
            compact ? 'text-xs' : 'text-sm'
          )}
        >
          {label}
        </span>
      ) : null}
      <strong
        title={valueTitle}
        className={cn(
          'kanban-usage-stat__value block font-semibold tabular-nums text-foreground',
          label && 'mt-1',
          compact && 'kanban-usage-stat__value--compact',
          valueClassName
        )}
      >
        {value}
      </strong>
      <div className="mt-1">{detail}</div>
    </div>
  );
}

export function UsageSummaryPrimary({
  title,
  icon,
  token,
  cache,
}: {
  title: ReactNode;
  icon: LucideIcon;
  token: ReactNode;
  cache: ReactNode;
}) {
  return (
    <section
      aria-label={typeof title === 'string' ? title : undefined}
      className="kanban-usage-card kanban-usage-summary__primary overflow-hidden p-4"
    >
      <UsageCardHeader icon={icon} title={title} className="mb-0" />
      <div className="kanban-usage-summary__primary-body">
        <div className="min-w-0">{token}</div>
        {cache}
      </div>
    </section>
  );
}

export function UsageSummaryMetrics({
  title,
  icon,
  children,
  ariaLabel,
}: {
  title: ReactNode;
  icon: LucideIcon;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <section
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
      className="kanban-usage-card flex min-w-0 flex-col justify-between overflow-hidden p-4"
    >
      <UsageCardHeader icon={icon} title={title} />
      <div className="kanban-usage-summary__metrics flex-1">{children}</div>
    </section>
  );
}

export function UsageHabitTile({ item }: { item: UsageHabitItem }) {
  const Icon = item.icon;
  const valueTitle =
    item.valueTitle ??
    (typeof item.value === 'string' ? item.value : undefined);
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1.5">
          <span className="truncate text-xs text-muted-foreground">
            {item.label}
          </span>
          {item.badge ? (
            <span className="shrink-0 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border/60">
              {item.badge}
            </span>
          ) : null}
        </div>
        <strong
          title={valueTitle}
          className="mt-0.5 block min-w-0 truncate text-xs font-semibold tabular-nums text-foreground"
        >
          {item.value}
        </strong>
      </div>
    </div>
  );
}

export function UsageHabitsCard({
  title,
  icon,
  items,
}: {
  title: string;
  icon: LucideIcon;
  items: UsageHabitItem[];
}) {
  return (
    <section
      aria-label={title}
      className="kanban-usage-card flex min-w-0 flex-col justify-between overflow-hidden p-4"
    >
      <UsageCardHeader icon={icon} title={title} />
      <div className="grid flex-1 grid-cols-2 gap-2">
        {items.map((item) => (
          <UsageHabitTile key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

export function UsageRankingMetricPill({
  value,
  title,
}: {
  value: ReactNode;
  title?: string;
  tone?: 'cost' | 'tokens' | 'sessions';
}) {
  return (
    <span
      title={title}
      className="kanban-usage-metric-pill inline-flex h-6 min-w-[72px] shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-center text-xs font-medium leading-none tabular-nums text-foreground/85"
    >
      {value}
    </span>
  );
}

export function UsageRankingItemCapsule({
  item,
  index,
  notProvided,
  tokensLabel,
  formatSessionsCount,
}: {
  item: UsageRankingItem;
  index: number;
  notProvided: string;
  tokensLabel: string;
  formatSessionsCount: (count: number) => string;
}) {
  return (
    <div className="flex h-9 items-center gap-2.5 rounded-full border border-border/50 bg-muted/30 px-3.5">
      <span
        className={cn(
          'w-4 shrink-0 text-center text-xs font-bold tabular-nums',
          index === 0 && 'kanban-rank-first',
          index === 1 && 'kanban-rank-second',
          index === 2 && 'kanban-rank-third',
          index >= 3 && 'text-muted-foreground'
        )}
      >
        {index + 1}
      </span>
      <div
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
        title={item.label}
      >
        {item.label}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <UsageRankingMetricPill
          tone="cost"
          value={formatOptionalCost(item.cost, notProvided)}
        />
        <UsageRankingMetricPill
          tone="tokens"
          value={`${formatOptionalNumber(item.totalTokens, notProvided)} ${tokensLabel}`}
        />
        <UsageRankingMetricPill
          tone="sessions"
          value={formatSessionsCount(item.sessionCount)}
        />
      </div>
    </div>
  );
}

export function UsageRankingCard({
  title,
  icon,
  emptyLabel,
  items,
  notProvided,
  tokensLabel,
  formatSessionsCount,
}: {
  title: string;
  icon: LucideIcon;
  emptyLabel: string;
  items: UsageRankingItem[];
  notProvided: string;
  tokensLabel: string;
  formatSessionsCount: (count: number) => string;
}) {
  return (
    <section className="kanban-usage-card flex min-w-0 flex-col p-4">
      <UsageCardHeader icon={icon} title={title} />
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-8 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="kanban-usage-ranking-list space-y-1.5">
          {items.map((item, index) => (
            <UsageRankingItemCapsule
              key={item.id}
              item={item}
              index={index}
              notProvided={notProvided}
              tokensLabel={tokensLabel}
              formatSessionsCount={formatSessionsCount}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function TokenCompositionList({
  tokens,
  notProvided,
  labels,
}: {
  tokens: ProjectUsageTokenCounts | null;
  notProvided: string;
  labels: {
    input: string;
    output: string;
    cacheWrite: string;
    cacheRead: string;
  };
}) {
  const total =
    tokens?.total_tokens ??
    ((tokens?.input_tokens ?? 0) +
      (tokens?.output_tokens ?? 0) +
      (tokens?.cache_write_tokens ?? 0) +
      (tokens?.cache_read_tokens ?? 0) ||
      null);

  const getPercentage = (value: number | null | undefined): number => {
    if (total == null || total <= 0 || value == null) return 0;
    return (value / total) * 100;
  };

  const rows = [
    {
      id: 'input',
      label: labels.input,
      value: tokens?.input_tokens ?? null,
      color: 'bg-foreground',
    },
    {
      id: 'output',
      label: labels.output,
      value: tokens?.output_tokens ?? null,
      color: 'bg-foreground/70',
    },
    {
      id: 'cacheWrite',
      label: labels.cacheWrite,
      value: tokens?.cache_write_tokens ?? null,
      color: 'bg-foreground/45',
    },
    {
      id: 'cacheRead',
      label: labels.cacheRead,
      value: tokens?.cache_read_tokens ?? null,
      color: 'bg-primary',
    },
  ];

  return (
    <div className="flex flex-1 flex-col justify-between gap-3">
      {rows.map((item) => {
        const percentage = getPercentage(item.value);
        return (
          <div key={item.id}>
            <div className="mb-1 flex items-baseline gap-3 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-foreground">
                {item.label}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
                {formatOptionalNumber(item.value, notProvided)}
              </span>
              <span className="w-11 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {percentage.toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted/70">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
                  item.color
                )}
                style={{
                  width: `${Math.max(percentage, (item.value ?? 0) > 0 ? 1.5 : 0)}%`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function UsageRing({ ratio, label }: { ratio: number; label: string }) {
  const safeRatio = Math.min(1, Math.max(0, ratio));
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="kanban-usage-summary__ring">
      <svg
        aria-label={`${label}: ${Math.round(safeRatio * 100)}%`}
        className="h-full w-full -rotate-90"
        viewBox="0 0 100 100"
        role="img"
      >
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth="7"
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - safeRatio)}
          className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      </svg>
      <span className="kanban-usage-summary__ring-value">
        {Math.round(safeRatio * 100)}%
      </span>
    </div>
  );
}
