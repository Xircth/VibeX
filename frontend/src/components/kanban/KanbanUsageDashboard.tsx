import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Flame,
  FolderOpen,
  Hash,
  List,
  type LucideIcon,
  Package,
  PieChart,
  RefreshCw,
  TrendingUp,
  UserCheck,
  Zap,
} from 'lucide-react';
import type {
  AgentAuthModeView,
  AgentManagementView,
  AgentPlanUsage,
} from 'shared/types';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { useProject } from '@/contexts/ProjectContext';
import {
  agentManagementApi,
  useAgentManagement,
} from '@/features/agent-management';
import { useProjects } from '@/hooks/useProjects';
import {
  localUsageApi,
  type ProjectUsageDailyUsage,
  type ProjectUsageSessionSummary,
  type ProjectUsageSourcedTokens,
  type ProjectUsageStatistics,
  type ProjectUsageTokenCounts,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { PlanUsageDashboard } from './PlanUsageDashboard';
import {
  clampPercent,
  describeReset,
  describeWindowLabel,
} from './planUsageFormat';

type UsageTab =
  | 'overview'
  | 'folders'
  | 'agents'
  | 'models'
  | 'sessions'
  | 'plan';
type DateRange = '7d' | '30d' | 'all';

const SESSIONS_PER_PAGE = 15;
const DATE_RANGE_OPTIONS: DateRange[] = ['7d', '30d', 'all'];
const USAGE_STATS_STALE_TIME_MS = 2 * 60_000;
const USAGE_STATS_GC_TIME_MS = 10 * 60_000;
const HEATMAP_OPACITIES = [0.18, 0.29, 0.4, 0.52, 0.64, 0.76, 0.88];

interface HeatmapHover {
  weekday: number;
  hour: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  containerWidth: number;
}

interface ModelCostRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

function modelMatches(model: string, candidates: string[]): boolean {
  const lower = model.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate));
}

function getModelCostRates(
  model: string | null | undefined
): ModelCostRates | null {
  if (!model || model === 'unprovided' || model === 'unknown') {
    return null;
  }

  if (modelMatches(model, ['claude', 'sonnet', 'opus', 'haiku'])) {
    if (
      modelMatches(model, [
        'claude-opus-5',
        'opus-5',
        'claude-opus-4-6',
        'claude-opus-4.6',
        'opus-4-6',
        'opus-4.6',
      ])
    ) {
      return { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 };
    }
    if (
      modelMatches(model, [
        'claude-opus-4-1',
        'claude-opus-4.1',
        'claude-opus-4',
        'claude-opus-3',
        'opus-4-1',
        'opus-4',
        'opus-3',
      ])
    ) {
      return { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 };
    }
    if (
      modelMatches(model, [
        'claude-haiku-4-5',
        'claude-haiku-4.5',
        'haiku-4-5',
        'haiku-4.5',
      ])
    ) {
      return { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };
    }
    if (modelMatches(model, ['claude-3-5-haiku', 'haiku-3.5', 'haiku-3-5'])) {
      return { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 };
    }
    if (modelMatches(model, ['claude-3-haiku', 'haiku-3'])) {
      return { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 };
  }

  if (modelMatches(model, ['gpt', 'codex', 'o1', 'o3', 'o4'])) {
    if (
      modelMatches(model, ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1', 'gpt-6'])
    ) {
      return { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 };
    }
    if (modelMatches(model, ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5-6'])) {
      return { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.4 };
    }
    if (modelMatches(model, ['gpt-5.5', 'gpt-5-5'])) {
      return { input: 5.0, output: 30.0, cacheWrite: 0, cacheRead: 0.5 };
    }
    if (modelMatches(model, ['gpt-5.4-mini'])) {
      return { input: 0.75, output: 4.5, cacheWrite: 0, cacheRead: 0.075 };
    }
    if (modelMatches(model, ['gpt-5.4-nano'])) {
      return { input: 0.2, output: 1.25, cacheWrite: 0, cacheRead: 0.02 };
    }
    if (modelMatches(model, ['gpt-5.4', 'gpt-5-4'])) {
      return { input: 2.5, output: 15.0, cacheWrite: 0, cacheRead: 0.25 };
    }
    if (modelMatches(model, ['gpt-5.2-pro'])) {
      return { input: 21.0, output: 168.0, cacheWrite: 0, cacheRead: 0 };
    }
    if (modelMatches(model, ['gpt-5-pro'])) {
      return { input: 15.0, output: 120.0, cacheWrite: 0, cacheRead: 0 };
    }
    if (modelMatches(model, ['gpt-5.2', 'gpt-5.2-chat', 'gpt-5.2-codex'])) {
      return { input: 1.75, output: 14.0, cacheWrite: 0, cacheRead: 0.175 };
    }
    if (modelMatches(model, ['gpt-5.1-codex-mini', 'gpt-5-mini'])) {
      return { input: 0.25, output: 2.0, cacheWrite: 0, cacheRead: 0.025 };
    }
    if (modelMatches(model, ['gpt-5-nano'])) {
      return { input: 0.05, output: 0.4, cacheWrite: 0, cacheRead: 0.005 };
    }
    if (
      modelMatches(model, [
        'gpt-5.1',
        'gpt-5.1-chat',
        'gpt-5.1-codex-max',
        'gpt-5.1-codex',
        'gpt-5-codex',
        'gpt-5-chat',
        'gpt-5',
      ])
    ) {
      return { input: 1.25, output: 10.0, cacheWrite: 0, cacheRead: 0.125 };
    }
    if (modelMatches(model, ['codex-mini-latest'])) {
      return { input: 1.5, output: 6.0, cacheWrite: 0, cacheRead: 0.375 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 0, cacheRead: 0.3 };
  }

  if (modelMatches(model, ['grok'])) {
    if (
      modelMatches(model, [
        'grok-4-fast',
        'grok-4-1-fast',
        'grok-4.1-fast',
        'grok-code-fast',
      ])
    ) {
      return { input: 0.2, output: 0.5, cacheWrite: 0, cacheRead: 0.05 };
    }
    if (
      modelMatches(model, ['grok-4.3', 'grok-4-3', 'grok-4.20', 'grok-4-20'])
    ) {
      return { input: 1.25, output: 2.5, cacheWrite: 0, cacheRead: 0.2 };
    }
    if (
      modelMatches(model, [
        'grok-4.7',
        'grok-4-7',
        'grok-4.6',
        'grok-4-6',
        'grok-4.5',
        'grok-4-5',
      ])
    ) {
      return { input: 2.0, output: 6.0, cacheWrite: 0, cacheRead: 0.5 };
    }
    if (modelMatches(model, ['grok-build'])) {
      return { input: 1.0, output: 2.0, cacheWrite: 0, cacheRead: 0.2 };
    }
    if (modelMatches(model, ['grok-3-mini', 'grok-2-mini'])) {
      return { input: 0.3, output: 0.5, cacheWrite: 0, cacheRead: 0.075 };
    }
    return { input: 3.0, output: 15.0, cacheWrite: 0, cacheRead: 0.75 };
  }

  if (modelMatches(model, ['gemini'])) {
    if (modelMatches(model, ['flash'])) {
      return { input: 0.3, output: 2.5, cacheWrite: 0, cacheRead: 0.03 };
    }
    return { input: 1.25, output: 10.0, cacheWrite: 0, cacheRead: 0.125 };
  }

  if (modelMatches(model, ['deepseek'])) {
    return { input: 0.28, output: 0.42, cacheWrite: 0, cacheRead: 0.028 };
  }

  if (modelMatches(model, ['kimi', 'moonshot'])) {
    return { input: 0.6, output: 2.5, cacheWrite: 0, cacheRead: 0.1 };
  }

  if (modelMatches(model, ['glm'])) {
    return { input: 0.6, output: 2.2, cacheWrite: 0, cacheRead: 0.11 };
  }

  if (modelMatches(model, ['minimax'])) {
    return { input: 0.3, output: 1.2, cacheWrite: 0.375, cacheRead: 0.03 };
  }

  if (modelMatches(model, ['qwen'])) {
    return { input: 0.4, output: 1.2, cacheWrite: 0, cacheRead: 0.04 };
  }

  return null;
}

function hasTokenCounts(
  counts: ProjectUsageTokenCounts | null | undefined
): counts is ProjectUsageTokenCounts {
  if (!counts) return false;
  return (
    counts.total_tokens != null ||
    counts.input_tokens != null ||
    counts.output_tokens != null ||
    counts.cache_write_tokens != null ||
    counts.cache_read_tokens != null
  );
}

function preferredTokenCounts(
  tokens: ProjectUsageSourcedTokens
): ProjectUsageTokenCounts | null {
  if (hasTokenCounts(tokens.vendor_log)) {
    return tokens.vendor_log;
  }
  if (hasTokenCounts(tokens.protocol)) {
    return tokens.protocol;
  }
  return null;
}

function preferredTokenTotal(tokens: ProjectUsageSourcedTokens): number | null {
  const counts = preferredTokenCounts(tokens);
  if (!counts) return null;
  if (counts.total_tokens != null) return counts.total_tokens;
  if (counts.input_tokens != null || counts.output_tokens != null) {
    return (
      (counts.input_tokens ?? 0) +
      (counts.output_tokens ?? 0) +
      (counts.cache_write_tokens ?? 0) +
      (counts.cache_read_tokens ?? 0)
    );
  }
  return null;
}

function estimateUsageCost(
  model: string | null | undefined,
  counts: ProjectUsageTokenCounts | null | undefined
): number | null {
  if (!counts || !hasTokenCounts(counts)) return null;
  const rates = getModelCostRates(model);
  if (!rates) return null;
  if (counts.input_tokens != null && counts.output_tokens != null) {
    const inputCost = (counts.input_tokens / 1_000_000) * rates.input;
    const outputCost = (counts.output_tokens / 1_000_000) * rates.output;
    const cacheWriteCost =
      ((counts.cache_write_tokens ?? 0) / 1_000_000) * rates.cacheWrite;
    const cacheReadCost =
      ((counts.cache_read_tokens ?? 0) / 1_000_000) * rates.cacheRead;
    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }
  if (counts.total_tokens != null) {
    return (counts.total_tokens / 1_000_000) * rates.input;
  }
  return null;
}

function normalizeUsageStatistics(
  raw: ProjectUsageStatistics | null
): ProjectUsageStatistics | null {
  if (!raw) return null;

  const sessions = raw.sessions.map((session) => {
    const resolvedCost =
      session.cost ??
      estimateUsageCost(session.model, preferredTokenCounts(session.tokens));
    return resolvedCost === session.cost
      ? session
      : { ...session, cost: resolvedCost };
  });

  const sumSessionCosts = (
    predicate: (session: ProjectUsageSessionSummary) => boolean
  ): number | null => {
    let sum = 0;
    let found = false;
    for (const session of sessions) {
      if (predicate(session) && session.cost != null) {
        sum += session.cost;
        found = true;
      }
    }
    return found ? sum : null;
  };

  const by_model = raw.by_model
    .map((modelItem) => {
      const resolvedCost =
        modelItem.cost ??
        estimateUsageCost(
          modelItem.model,
          preferredTokenCounts(modelItem.tokens)
        ) ??
        sumSessionCosts(
          (session) => (session.model ?? 'unprovided') === modelItem.model
        );
      return resolvedCost === modelItem.cost
        ? modelItem
        : { ...modelItem, cost: resolvedCost };
    })
    .sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1));

  const by_folder = raw.by_folder.map((folderItem) => {
    const resolvedCost =
      folderItem.cost ??
      sumSessionCosts(
        (session) => session.workspace_id === folderItem.workspace_id
      );
    return resolvedCost === folderItem.cost
      ? folderItem
      : { ...folderItem, cost: resolvedCost };
  });

  const by_agent = raw.by_agent.map((agentItem) => {
    const resolvedCost =
      agentItem.cost ??
      sumSessionCosts(
        (session) => (session.agent_id ?? 'unprovided') === agentItem.agent_id
      ) ??
      (agentItem.agent_id.toLowerCase().includes('grok')
        ? estimateUsageCost('grok-4.6', preferredTokenCounts(agentItem.tokens))
        : null);
    return resolvedCost === agentItem.cost
      ? agentItem
      : { ...agentItem, cost: resolvedCost };
  });

  const daily_usage = raw.daily_usage.map((dayItem) => {
    if (dayItem.cost != null) return dayItem;
    const fallbackModel = dayItem.models_used?.[0] ?? null;
    const resolvedCost =
      estimateUsageCost(fallbackModel, preferredTokenCounts(dayItem.tokens)) ??
      null;
    return resolvedCost == null ? dayItem : { ...dayItem, cost: resolvedCost };
  });

  const estimated_cost =
    raw.estimated_cost ??
    sumSessionCosts(() => true) ??
    by_model.reduce<number | null>(
      (acc, item) => (item.cost != null ? (acc ?? 0) + item.cost : acc),
      null
    );

  return {
    ...raw,
    estimated_cost,
    sessions,
    daily_usage,
    by_model,
    by_folder,
    by_agent,
  };
}

function UsageCardHeader({
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

function OverviewStat({
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

function UsageSummaryPrimary({
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

function UsageSummaryMetrics({
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

interface UsageHabitItem {
  id: string;
  icon: LucideIcon;
  label: string;
  value: string;
  badge: string;
}

function UsageHabitTile({ item }: { item: UsageHabitItem }) {
  const Icon = item.icon;
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1.5">
          <span className="truncate text-[11px] text-muted-foreground">
            {item.label}
          </span>
          <span className="shrink-0 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border/60">
            {item.badge}
          </span>
        </div>
        <strong
          title={item.value}
          className="mt-0.5 block truncate text-xs font-semibold tabular-nums text-foreground"
        >
          {item.value}
        </strong>
      </div>
    </div>
  );
}

function UsageHabitsCard({
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

interface UsageRankingItem {
  id: string;
  label: string;
  cost?: number | null;
  totalTokens: number | null;
  sessionCount: number;
}

function UsageRankingMetricPill({
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
      className="kanban-usage-metric-pill inline-flex h-6 min-w-[72px] shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-center text-[11px] font-medium leading-none tabular-nums text-foreground/85"
    >
      {value}
    </span>
  );
}

function UsageRankingItemCapsule({
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

function UsageRankingCard({
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

function TokenCompositionList({
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
              <span className="w-11 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
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

const PLAN_USAGE_STALE_TIME_MS = 180_000;
const PLAN_CAPABLE_AGENT_IDS = [
  'claude_code',
  'codex',
  'grok',
  'cursor',
] as const;

type PlanCapableAgentId = (typeof PLAN_CAPABLE_AGENT_IDS)[number];

const SUBSCRIPTION_MODES: Record<PlanCapableAgentId, string> = {
  claude_code: 'official_subscription',
  codex: 'chatgpt_subscription',
  grok: 'subscription',
  cursor: 'subscription',
};

function isPlanCapableAgentId(agentId: string): agentId is PlanCapableAgentId {
  return (PLAN_CAPABLE_AGENT_IDS as readonly string[]).includes(agentId);
}

function isSignedInSubscription(
  agent: AgentManagementView,
  authMode: AgentAuthModeView | undefined
) {
  return (
    agent.enabled &&
    agent.authentication === 'account' &&
    isPlanCapableAgentId(agent.agent_id) &&
    authMode?.mode === SUBSCRIPTION_MODES[agent.agent_id]
  );
}

function OverviewSubscriptionPlansCard() {
  const { t } = useTranslation('tasks');
  const management = useAgentManagement();
  const candidatePlanAgents = useMemo(
    () =>
      management.state.agents.filter(
        (agent) =>
          agent.enabled &&
          agent.authentication === 'account' &&
          isPlanCapableAgentId(agent.agent_id)
      ),
    [management.state.agents]
  );

  const authQueries = useQueries({
    queries: candidatePlanAgents.map((agent) => ({
      queryKey: ['agent-auth-mode', agent.agent_id],
      queryFn: () => agentManagementApi.authMode(agent.agent_id),
      staleTime: PLAN_USAGE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    })),
  });

  const subscribedPlanAgents = useMemo(
    () =>
      candidatePlanAgents.filter((agent, index) =>
        isSignedInSubscription(agent, authQueries[index]?.data)
      ),
    [authQueries, candidatePlanAgents]
  );

  const planQueries = useQueries({
    queries: subscribedPlanAgents.map((agent) => ({
      queryKey: ['agent-plan-usage', agent.agent_id],
      queryFn: () => agentManagementApi.planUsage(agent.agent_id),
      staleTime: PLAN_USAGE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    })),
  });

  const activeSubscriptionPlans = useMemo(() => {
    const items: Array<{
      agent: AgentManagementView;
      usage: AgentPlanUsage;
    }> = [];
    subscribedPlanAgents.forEach((agent, index) => {
      const result = planQueries[index]?.data;
      if (
        result?.type === 'OK' &&
        (result.usage.windows.length > 0 || result.usage.credits != null)
      ) {
        items.push({ agent, usage: result.usage });
      }
    });
    return items;
  }, [planQueries, subscribedPlanAgents]);

  if (activeSubscriptionPlans.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t('usageDashboard.subscriptionPlansTitle')}
      data-testid="overview-subscription-plans-card"
      className="kanban-usage-card flex min-w-0 flex-col p-4"
    >
      <UsageCardHeader
        icon={Package}
        title={t('usageDashboard.subscriptionPlansTitle')}
      />
      <div className="flex flex-col gap-3">
        {activeSubscriptionPlans.map(({ agent, usage }) => {
          const agentLabel = agent.display_name || agent.agent_id;
          const windows = usage.windows;
          const columnCount = Math.max(1, windows.length);

          return (
            <div
              key={agent.agent_id}
              data-testid={`subscription-plan-row-${agent.agent_id}`}
              className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex w-40 shrink-0 items-center gap-2 min-w-0">
                <AgentManagementIcon
                  agent={agent}
                  className="size-4 shrink-0"
                />
                <span
                  title={agentLabel}
                  className="truncate text-[13px] font-medium text-foreground"
                >
                  {agentLabel}
                </span>
              </div>

              {windows.length > 0 ? (
                <div
                  data-testid={`subscription-plan-windows-${agent.agent_id}`}
                  className="grid min-w-0 flex-1 items-center gap-4"
                  style={{
                    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  }}
                >
                  {windows.map((window) => {
                    const usedPercent = clampPercent(window.usedPercent);
                    const remainingPercent =
                      usedPercent === null
                        ? null
                        : Math.max(0, 100 - usedPercent);
                    const labelDesc = describeWindowLabel(window);
                    const windowLabel = t(
                      `usageDashboard.planUsage.${labelDesc.key}`,
                      labelDesc.count === undefined
                        ? undefined
                        : { count: labelDesc.count }
                    );
                    const reset = describeReset(window.resetsAtMs, Date.now());
                    const resetLabel =
                      reset === null
                        ? null
                        : reset.kind === 'soon'
                          ? t('usageDashboard.planUsage.resetsSoon')
                          : t(
                              `usageDashboard.planUsage.${
                                reset.kind === 'minutes'
                                  ? 'resetsInMinutes'
                                  : reset.kind === 'hours'
                                    ? 'resetsInHours'
                                    : 'resetsInDays'
                              }`,
                              { count: reset.count }
                            );
                    const tooltipText = [
                      windowLabel,
                      usedPercent !== null
                        ? t('usageDashboard.planUsage.used', {
                            percent: usedPercent,
                          })
                        : null,
                      remainingPercent !== null
                        ? t('usageDashboard.planUsage.remaining', {
                            percent: remainingPercent,
                          })
                        : null,
                      resetLabel,
                    ]
                      .filter(Boolean)
                      .join(' · ');

                    return (
                      <div
                        key={window.id}
                        title={tooltipText}
                        className="flex min-w-0 items-center gap-2.5"
                      >
                        <span className="inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-[11px] font-medium leading-none text-foreground/85">
                          {windowLabel}
                        </span>
                        <ProgressBar
                          value={usedPercent ?? 0}
                          max={100}
                          label={`${agentLabel} ${windowLabel}`}
                          isLabelHidden
                          hasValueLabel={false}
                          variant={
                            usedPercent !== null && usedPercent >= 90
                              ? 'error'
                              : usedPercent !== null && usedPercent >= 70
                                ? 'warning'
                                : 'accent'
                          }
                          className="min-w-0 flex-1"
                        />
                        <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {usedPercent === null ? '--' : `${usedPercent}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {usage.credits ? (
                <span className="inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-[11px] font-medium leading-none tabular-nums text-foreground/85">
                  {usage.credits.unlimited
                    ? t('usageDashboard.planUsage.creditsUnlimited')
                    : t('usageDashboard.planUsage.creditsBalance', {
                        balance: usage.credits.balance ?? '--',
                      })}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface DimensionSubBreakdown {
  dailyAvgTokens: number | null;
  activeDaysCount: number;
  totalCost: number | null;
  sessionCount: number;
  tokenCounts: ProjectUsageTokenCounts | null;
  topAgents: UsageRankingItem[];
  topModels: UsageRankingItem[];
  topFolders: UsageRankingItem[];
}

function buildDimensionSubBreakdown(
  sessions: ProjectUsageSessionSummary[],
  fallbackTokens: ProjectUsageSourcedTokens,
  fallbackCost: number | null | undefined,
  fallbackSessionCount: number,
  notProvided: string,
  resolveProjectName: (
    folderPath: string | null | undefined,
    workspaceId: string
  ) => string
): DimensionSubBreakdown {
  const fallbackCounts = preferredTokenCounts(fallbackTokens);
  if (sessions.length === 0) {
    return {
      dailyAvgTokens: fallbackCounts?.total_tokens ?? null,
      activeDaysCount: fallbackCounts?.total_tokens ? 1 : 0,
      totalCost: fallbackCost ?? null,
      sessionCount: fallbackSessionCount,
      tokenCounts: fallbackCounts,
      topAgents: [],
      topModels: [],
      topFolders: [],
    };
  }

  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let total = 0;
  let hasTokens = false;
  let costSum = 0;
  let hasCost = false;
  const activeDaySet = new Set<string>();
  const agentMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();
  const modelMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();
  const folderMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();

  for (const session of sessions) {
    const counts = preferredTokenCounts(session.tokens);
    const sessionTotal = preferredTokenTotal(session.tokens);
    if (counts) {
      input += counts.input_tokens ?? 0;
      output += counts.output_tokens ?? 0;
      cacheWrite += counts.cache_write_tokens ?? 0;
      cacheRead += counts.cache_read_tokens ?? 0;
      total += sessionTotal ?? 0;
      hasTokens = true;
    }
    if (sessionTotal != null && sessionTotal > 0) {
      const date = new Date(session.timestamp);
      if (!Number.isNaN(date.getTime())) {
        activeDaySet.add(
          `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
        );
      }
    }
    if (session.cost != null) {
      costSum += session.cost;
      hasCost = true;
    }

    const agentKey = session.agent_id || 'unprovided';
    const agentEntry = agentMap.get(agentKey) ?? {
      label: displayUsageLabel(session.agent_id, notProvided),
      cost: null,
      tokens: null,
      count: 0,
    };
    agentEntry.count += 1;
    if (session.cost != null) {
      agentEntry.cost = (agentEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      agentEntry.tokens = (agentEntry.tokens ?? 0) + sessionTotal;
    }
    agentMap.set(agentKey, agentEntry);

    const modelKey = session.model || 'unprovided';
    const modelEntry = modelMap.get(modelKey) ?? {
      label: displayUsageLabel(session.model, notProvided),
      cost: null,
      tokens: null,
      count: 0,
    };
    modelEntry.count += 1;
    if (session.cost != null) {
      modelEntry.cost = (modelEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      modelEntry.tokens = (modelEntry.tokens ?? 0) + sessionTotal;
    }
    modelMap.set(modelKey, modelEntry);

    const folderKey = session.workspace_id;
    const folderEntry = folderMap.get(folderKey) ?? {
      label: resolveProjectName(session.folder, session.workspace_id),
      cost: null,
      tokens: null,
      count: 0,
    };
    folderEntry.count += 1;
    if (session.cost != null) {
      folderEntry.cost = (folderEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      folderEntry.tokens = (folderEntry.tokens ?? 0) + sessionTotal;
    }
    folderMap.set(folderKey, folderEntry);
  }

  const resolvedTokenCounts: ProjectUsageTokenCounts | null = hasTokens
    ? {
        input_tokens: input,
        output_tokens: output,
        cache_write_tokens: cacheWrite,
        cache_read_tokens: cacheRead,
        total_tokens: total,
      }
    : fallbackCounts;

  const activeDaysCount =
    activeDaySet.size || (resolvedTokenCounts?.total_tokens ? 1 : 0);
  const resolvedTotalTokens = resolvedTokenCounts?.total_tokens ?? null;
  const dailyAvgTokens =
    resolvedTotalTokens != null && activeDaysCount > 0
      ? resolvedTotalTokens / activeDaysCount
      : null;

  const toRankingList = (
    map: Map<
      string,
      {
        label: string;
        cost: number | null;
        tokens: number | null;
        count: number;
      }
    >
  ): UsageRankingItem[] =>
    Array.from(map.entries())
      .map(([id, item]) => ({
        id,
        label: item.label,
        cost: item.cost,
        totalTokens: item.tokens,
        sessionCount: item.count,
      }))
      .sort(
        (left, right) =>
          right.sessionCount - left.sessionCount ||
          (right.totalTokens ?? 0) - (left.totalTokens ?? 0)
      );

  return {
    dailyAvgTokens,
    activeDaysCount,
    totalCost: fallbackCost ?? (hasCost ? costSum : null),
    sessionCount: fallbackSessionCount || sessions.length,
    tokenCounts: resolvedTokenCounts,
    topAgents: toRankingList(agentMap),
    topModels: toRankingList(modelMap),
    topFolders: toRankingList(folderMap),
  };
}

function UsageRing({ ratio, label }: { ratio: number; label: string }) {
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

function formatOptionalNumber(
  value: number | null | undefined,
  notProvided: string
): string {
  return value == null ? notProvided : formatNumber(value);
}

function formatOptionalCost(
  value: number | null | undefined,
  notProvided: string
): string {
  return value == null ? notProvided : formatCost(value);
}

function displayUsageLabel(
  value: string | null | undefined,
  notProvided: string
): string {
  if (value == null || value === '' || value === 'unprovided') {
    return notProvided;
  }
  return value;
}

function extractFolderBasename(
  folderPath: string | null | undefined,
  fallback: string
): string {
  if (!folderPath) return fallback;
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || fallback;
}

function UsageHeatmap({
  sessions,
}: {
  sessions: ProjectUsageSessionSummary[];
}) {
  const { t } = useTranslation('tasks');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HeatmapHover | null>(null);
  const matrix = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
    sessions.forEach((session) => {
      const date = new Date(session.timestamp);
      if (Number.isNaN(date.getTime())) return;
      const total = preferredTokenTotal(session.tokens);
      if (total == null) return;
      const weekday = (date.getDay() + 6) % 7;
      cells[weekday][date.getHours()] += total;
    });
    return cells;
  }, [sessions]);
  const max = Math.max(1, ...matrix.flat());
  const busiestHour = useMemo(() => {
    const totals = Array.from({ length: 24 }, (_, hour) =>
      matrix.reduce((sum, row) => sum + row[hour], 0)
    );
    const peak = Math.max(...totals);
    return peak > 0 ? totals.indexOf(peak) : null;
  }, [matrix]);
  const weekdayLabels = [
    t('usageDashboard.weekdayMon'),
    t('usageDashboard.weekdayTue'),
    t('usageDashboard.weekdayWed'),
    t('usageDashboard.weekdayThu'),
    t('usageDashboard.weekdayFri'),
    t('usageDashboard.weekdaySat'),
    t('usageDashboard.weekdaySun'),
  ];

  return (
    <div
      ref={wrapperRef}
      className="relative flex min-h-0 flex-1 flex-col justify-between gap-2"
    >
      <div
        className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1"
        style={{ gridTemplateRows: 'auto repeat(7, auto)' }}
        onMouseLeave={() => setHover(null)}
      >
        <span />
        <div
          className="mb-0.5 grid text-[10px] leading-none text-muted-foreground"
          style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
        >
          {[0, 6, 12, 18].map((hour) => (
            <span
              key={hour}
              className="tabular-nums"
              style={{ gridColumn: `${hour + 1} / span 2` }}
            >
              {hour}
            </span>
          ))}
          <span
            className="text-right tabular-nums"
            style={{ gridColumn: '23 / span 2' }}
          >
            23
          </span>
        </div>
        {matrix.map((row, weekday) => (
          <div key={weekday} className="contents">
            <span className="flex items-center pr-0.5 text-[10px] leading-none text-muted-foreground">
              {weekday % 2 === 0 ? weekdayLabels[weekday] : ''}
            </span>
            <div
              className="grid items-center gap-1"
              style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
            >
              {row.map((value, hour) => {
                const intensity =
                  value > 0
                    ? Math.min(
                        HEATMAP_OPACITIES.length - 1,
                        Math.max(
                          0,
                          Math.ceil(
                            Math.sqrt(value / max) * HEATMAP_OPACITIES.length
                          ) - 1
                        )
                      )
                    : null;
                return (
                  <div
                    key={hour}
                    role="img"
                    aria-label={t('usageDashboard.heatmapCell', {
                      weekday: weekdayLabels[weekday],
                      hour: `${String(hour).padStart(2, '0')}:00`,
                      value: formatNumber(value),
                    })}
                    className={cn(
                      'aspect-[4/3] w-full rounded-[3px]',
                      intensity === null &&
                        'bg-muted/40 ring-1 ring-inset ring-border/50'
                    )}
                    style={
                      intensity === null
                        ? undefined
                        : {
                            backgroundColor: `hsl(var(--primary) / ${HEATMAP_OPACITIES[intensity]})`,
                          }
                    }
                    onMouseEnter={(event) => {
                      const wrapper = wrapperRef.current;
                      if (!wrapper) return;
                      const cellBox =
                        event.currentTarget.getBoundingClientRect();
                      const wrapperBox = wrapper.getBoundingClientRect();
                      setHover({
                        weekday,
                        hour,
                        value,
                        x: cellBox.left - wrapperBox.left,
                        y: cellBox.top - wrapperBox.top,
                        width: cellBox.width,
                        height: cellBox.height,
                        containerWidth: wrapperBox.width,
                      });
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>{t('usageDashboard.heatmapLess')}</span>
        <span className="aspect-[4/3] w-3 rounded-[2px] bg-muted/40 ring-1 ring-inset ring-border/50" />
        {HEATMAP_OPACITIES.map((opacity) => (
          <span
            key={opacity}
            className="aspect-[4/3] w-3 rounded-[2px]"
            style={{ backgroundColor: `hsl(var(--primary) / ${opacity})` }}
          />
        ))}
        <span>{t('usageDashboard.heatmapMore')}</span>
      </div>
      {busiestHour !== null ? (
        <div className="text-[10px] text-muted-foreground">
          {t('usageDashboard.heatmapPeakHint', {
            hour: String(busiestHour).padStart(2, '0'),
          })}
        </div>
      ) : null}

      {hover ? (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute rounded-[3px] ring-2 ring-foreground/35"
            style={{
              left: hover.x - 1,
              top: hover.y - 1,
              width: hover.width + 2,
              height: hover.height + 2,
            }}
          />
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--radius)] border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{
              left: Math.min(
                Math.max(hover.x + hover.width / 2, 56),
                Math.max(56, hover.containerWidth - 56)
              ),
              top: hover.y - 6,
            }}
          >
            <div className="font-medium text-popover-foreground">
              {weekdayLabels[hover.weekday]}{' '}
              {String(hover.hour).padStart(2, '0')}:00
            </div>
            <div className="mt-0.5 text-right font-mono tabular-nums text-muted-foreground">
              {formatNumber(hover.value)} {t('usageDashboard.tokens')}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function formatNumber(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(1)}B`;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return Math.max(0, Math.round(safe)).toString();
}

function formatCost(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(4)}`;
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function formatTrendTooltipDate(
  dateStr: string,
  weekdayLabels: string[]
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdayIdx = (date.getDay() + 6) % 7;
  const weekday = weekdayLabels[weekdayIdx] ?? '';
  return `${month}月${day}日周${weekday}`;
}

function getUsageTargetScope(target: string): 'global' | 'project' {
  return target === 'global' ? 'global' : 'project';
}

function getUsageTargetProjectId(target: string): string | undefined {
  return target === 'global' ? undefined : target.replace(/^project:/, '');
}

function getUsageStatisticsQueryOptions(target: string, dateRange: DateRange) {
  return {
    queryKey: ['kanbanUsageStatistics', target, dateRange],
    queryFn: () =>
      localUsageApi.getProjectStatistics({
        scope: getUsageTargetScope(target),
        projectId: getUsageTargetProjectId(target),
        dateRange,
      }),
    placeholderData: (previousData: ProjectUsageStatistics | undefined) =>
      previousData,
    staleTime: USAGE_STATS_STALE_TIME_MS,
    gcTime: USAGE_STATS_GC_TIME_MS,
  };
}

export function KanbanUsageDashboard() {
  const { t } = useTranslation(['tasks', 'common']);
  const { projectId } = useProject();
  const { projects } = useProjects();
  const preferredProjectTarget = projectId ? `project:${projectId}` : 'global';
  const [selectedTarget, setSelectedTarget] = useState<string>(
    preferredProjectTarget
  );
  const [activeTab, setActiveTab] = useState<UsageTab>('overview');
  const [dateRange, setDateRange] = useState<DateRange>('7d');
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSortBy, setSessionSortBy] = useState<'cost' | 'time'>('cost');
  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: {
      date: string;
      cost: number | null;
      sessions: number;
      totalTokens: number;
      freshTokens: number;
      cacheReadTokens: number;
    };
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: {
      date: '',
      cost: null,
      sessions: 0,
      totalTokens: 0,
      freshTokens: 0,
      cacheReadTokens: 0,
    },
  });
  const targetOptions = useMemo(
    () => [
      { value: 'global', label: t('usageDashboard.global') },
      ...projects.map((project) => ({
        value: `project:${project.id}`,
        label: project.name,
      })),
    ],
    [projects, t]
  );

  const statisticsQuery = useQuery({
    ...getUsageStatisticsQueryOptions(selectedTarget, dateRange),
    enabled: activeTab !== 'plan',
  });

  const statistics = useMemo(
    () => normalizeUsageStatistics(statisticsQuery.data ?? null),
    [statisticsQuery.data]
  );
  const loading = statisticsQuery.isLoading && !statistics;
  const error =
    statisticsQuery.error instanceof Error
      ? statisticsQuery.error.message
      : statisticsQuery.error
        ? String(statisticsQuery.error)
        : null;

  useEffect(() => {
    if (!projectId) {
      setSelectedTarget('global');
      return;
    }

    setSelectedTarget((prev) =>
      prev === 'global' ? prev : preferredProjectTarget
    );
  }, [preferredProjectTarget, projectId]);

  useEffect(() => {
    setSessionPage(1);
  }, [dateRange, selectedTarget, sessionSortBy]);

  const formatDate = useCallback(
    (timestamp: number): string => {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return t('usageDashboard.today');
      if (diffDays === 1) return t('usageDashboard.yesterday');
      if (diffDays < 7) return t('usageDashboard.daysAgo', { count: diffDays });

      return date.toLocaleDateString('zh-CN', {
        month: 'short',
        day: 'numeric',
      });
    },
    [t]
  );

  const formatRelativeTime = useCallback(
    (timestamp: number): string => {
      const now = Date.now();
      const diffMs = now - timestamp;
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) return t('usageDashboard.justNow');
      if (diffMin < 60)
        return t('usageDashboard.minutesAgo', { count: diffMin });
      if (diffHour < 24)
        return t('usageDashboard.hoursAgo', { count: diffHour });

      return formatDate(timestamp);
    },
    [formatDate, t]
  );

  const renderTrend = useCallback(
    (value: number) => {
      if (value === 0) {
        return (
          <span className="text-[10px] text-muted-foreground">
            {t('usageDashboard.trendFlat')}
          </span>
        );
      }

      const isUp = value > 0;
      return (
        <span
          className={cn(
            'text-[10px] font-medium',
            isUp
              ? 'text-[hsl(var(--destructive))]'
              : 'text-[hsl(var(--success))]'
          )}
        >
          {isUp ? t('usageDashboard.trendUp') : t('usageDashboard.trendDown')}{' '}
          {Math.abs(value).toFixed(1)}%
        </span>
      );
    },
    [t]
  );

  const resolveProjectName = useCallback(
    (folderPath: string | null | undefined, workspaceId: string): string => {
      if (folderPath) {
        const lowerPath = folderPath.toLowerCase();
        const matched = projects.find((proj) =>
          lowerPath.endsWith(proj.name.toLowerCase())
        );
        if (matched) return matched.name;
      }
      return extractFolderBasename(folderPath, workspaceId);
    },
    [projects]
  );

  const filteredSessions = useMemo(() => {
    const source = statistics?.sessions ?? [];
    return source.slice().sort((left, right) => {
      if (sessionSortBy === 'cost') {
        return (right.cost ?? -1) - (left.cost ?? -1);
      }
      return right.timestamp - left.timestamp;
    });
  }, [sessionSortBy, statistics?.sessions]);

  const paginatedSessions = useMemo(
    () =>
      filteredSessions.slice(
        (sessionPage - 1) * SESSIONS_PER_PAGE,
        sessionPage * SESSIONS_PER_PAGE
      ),
    [filteredSessions, sessionPage]
  );

  const totalPages = Math.max(
    1,
    Math.ceil(filteredSessions.length / SESSIONS_PER_PAGE)
  );

  const filteredDailyUsage = useMemo<ProjectUsageDailyUsage[]>(
    () => statistics?.daily_usage ?? [],
    [statistics?.daily_usage]
  );

  const maxDailyTokens = useMemo(
    () =>
      Math.max(
        1,
        ...filteredDailyUsage.map((day) => preferredTokenTotal(day.tokens) ?? 0)
      ),
    [filteredDailyUsage]
  );

  const trendLinePoints = useMemo(
    () =>
      filteredDailyUsage.map((day, index) => {
        const totalTokens = preferredTokenTotal(day.tokens) ?? 0;
        const xPct =
          filteredDailyUsage.length > 0
            ? ((index + 0.5) / filteredDailyUsage.length) * 100
            : 50;
        const heightPct = Math.min(
          98,
          Math.max(
            totalTokens > 0 ? 3 : 1,
            (totalTokens / maxDailyTokens) * 100
          )
        );
        const yPct = 100 - heightPct;
        return {
          date: day.date,
          xPct,
          yPct,
          heightPct,
          totalTokens,
        };
      }),
    [filteredDailyUsage, maxDailyTokens]
  );

  const trendPolylinePointsAttr = useMemo(
    () =>
      trendLinePoints
        .map((point) => `${point.xPct.toFixed(2)},${point.yPct.toFixed(2)}`)
        .join(' '),
    [trendLinePoints]
  );

  const failedProviders =
    statistics?.provider_status?.filter((provider) => !provider.success) ?? [];

  const tabs = [
    {
      key: 'overview' as UsageTab,
      label: t('usageDashboard.tabOverview'),
      icon: TrendingUp,
      activeColor: 'is-active',
    },
    {
      key: 'folders' as UsageTab,
      label: t('usageDashboard.tabFolders'),
      icon: FolderOpen,
      activeColor: 'is-active',
    },
    {
      key: 'agents' as UsageTab,
      label: t('usageDashboard.tabAgents'),
      icon: Zap,
      activeColor: 'is-active',
    },
    {
      key: 'models' as UsageTab,
      label: t('usageDashboard.tabModels'),
      icon: Hash,
      activeColor: 'is-active',
    },
    {
      key: 'sessions' as UsageTab,
      label: t('usageDashboard.tabSessions'),
      icon: List,
      activeColor: 'is-active',
    },
    {
      key: 'plan' as UsageTab,
      label: t('usageDashboard.tabPlan'),
      icon: Package,
      activeColor: 'is-active',
    },
  ];

  const weekdayLabels = useMemo(
    () => [
      t('usageDashboard.weekdayMon'),
      t('usageDashboard.weekdayTue'),
      t('usageDashboard.weekdayWed'),
      t('usageDashboard.weekdayThu'),
      t('usageDashboard.weekdayFri'),
      t('usageDashboard.weekdaySat'),
      t('usageDashboard.weekdaySun'),
    ],
    [t]
  );

  const notProvided = t('usageDashboard.notProvided');
  const topModels = useMemo<UsageRankingItem[]>(
    () =>
      (statistics?.by_model ?? []).map((model) => ({
        id: model.model,
        label: displayUsageLabel(model.model, notProvided),
        cost: model.cost,
        totalTokens: preferredTokenTotal(model.tokens),
        sessionCount: model.session_count,
      })),
    [notProvided, statistics?.by_model]
  );
  const topProjects = useMemo<UsageRankingItem[]>(
    () =>
      (statistics?.by_folder ?? []).map((folder) => ({
        id: folder.workspace_id,
        label: folder.folder || folder.workspace_id,
        cost: folder.cost,
        totalTokens: preferredTokenTotal(folder.tokens),
        sessionCount: folder.session_count,
      })),
    [statistics?.by_folder]
  );
  const topAgents = useMemo<UsageRankingItem[]>(
    () =>
      (statistics?.by_agent ?? []).map((agent) => ({
        id: agent.agent_id,
        label: displayUsageLabel(agent.agent_id, notProvided),
        cost: agent.cost,
        totalTokens: preferredTokenTotal(agent.tokens),
        sessionCount: agent.session_count,
      })),
    [notProvided, statistics?.by_agent]
  );

  const activeDaysCount = useMemo(
    () =>
      filteredDailyUsage.filter(
        (day) => (preferredTokenTotal(day.tokens) ?? 0) > 0
      ).length,
    [filteredDailyUsage]
  );

  const dailyAvgActiveTokens = useMemo(() => {
    if (!statistics || activeDaysCount === 0) return null;
    const total = preferredTokenTotal(statistics.total_tokens);
    if (total != null) {
      return total / activeDaysCount;
    }
    const activeSum = filteredDailyUsage.reduce(
      (sum, day) => sum + (preferredTokenTotal(day.tokens) ?? 0),
      0
    );
    return activeSum > 0 ? activeSum / activeDaysCount : null;
  }, [activeDaysCount, filteredDailyUsage, statistics]);

  const activeWorkHours = useMemo(() => {
    const sessions = statistics?.sessions ?? [];
    if (sessions.length === 0) return null;
    const tokenBuckets = Array(24).fill(0);
    const sessionBuckets = Array(24).fill(0);
    sessions.forEach((session) => {
      const date = new Date(session.timestamp);
      if (Number.isNaN(date.getTime())) return;
      const hour = date.getHours();
      sessionBuckets[hour] += 1;
      const total = preferredTokenTotal(session.tokens);
      if (total != null && total > 0) {
        tokenBuckets[hour] += total;
      }
    });
    const maxTokens = Math.max(...tokenBuckets);
    const buckets = maxTokens > 0 ? tokenBuckets : sessionBuckets;
    const peak = Math.max(...buckets);
    if (peak <= 0) return null;
    const peakHour = buckets.indexOf(peak);
    const nextHour = (peakHour + 1) % 24;
    const periodKey =
      peakHour < 6
        ? 'periodLateNight'
        : peakHour < 12
          ? 'periodMorning'
          : peakHour < 18
            ? 'periodAfternoon'
            : 'periodEvening';
    return {
      range: `${String(peakHour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`,
      periodLabel: t(`usageDashboard.${periodKey}`),
    };
  }, [statistics?.sessions, t]);

  const favoriteAgent = useMemo(() => {
    const agents = statistics?.by_agent ?? [];
    if (agents.length === 0) return null;
    return (
      agents
        .slice()
        .sort(
          (left, right) =>
            right.session_count - left.session_count ||
            (preferredTokenTotal(right.tokens) ?? 0) -
              (preferredTokenTotal(left.tokens) ?? 0)
        )[0] ?? null
    );
  }, [statistics?.by_agent]);

  const favoriteModel = useMemo(() => {
    const models = statistics?.by_model ?? [];
    if (models.length === 0) return null;
    return (
      models
        .slice()
        .sort(
          (left, right) =>
            right.session_count - left.session_count ||
            (preferredTokenTotal(right.tokens) ?? 0) -
              (preferredTokenTotal(left.tokens) ?? 0)
        )[0] ?? null
    );
  }, [statistics?.by_model]);

  const habitItems = useMemo<UsageHabitItem[]>(
    () => [
      {
        id: 'activeHours',
        icon: Clock,
        label: t('usageDashboard.activeHours'),
        value: activeWorkHours?.range ?? notProvided,
        badge: activeWorkHours?.periodLabel ?? t('usageDashboard.noData'),
      },
      {
        id: 'dailyAvgActiveTokens',
        icon: Zap,
        label: t('usageDashboard.dailyAvgActiveTokens'),
        value: formatOptionalNumber(dailyAvgActiveTokens, notProvided),
        badge: t('usageDashboard.dailyAvgActiveDetail'),
      },
      {
        id: 'favoriteAgent',
        icon: Cpu,
        label: t('usageDashboard.favoriteAgent'),
        value: favoriteAgent
          ? displayUsageLabel(favoriteAgent.agent_id, notProvided)
          : notProvided,
        badge: favoriteAgent
          ? t('usageDashboard.sessionsCount', {
              count: favoriteAgent.session_count,
            })
          : t('usageDashboard.noAgentData'),
      },
      {
        id: 'favoriteModel',
        icon: Hash,
        label: t('usageDashboard.favoriteModel'),
        value: favoriteModel
          ? displayUsageLabel(favoriteModel.model, notProvided)
          : notProvided,
        badge: favoriteModel
          ? t('usageDashboard.sessionsCount', {
              count: favoriteModel.session_count,
            })
          : t('usageDashboard.noModelData'),
      },
    ],
    [
      activeWorkHours,
      dailyAvgActiveTokens,
      favoriteAgent,
      favoriteModel,
      notProvided,
      t,
    ]
  );

  const displayTokens = statistics
    ? preferredTokenCounts(statistics.total_tokens)
    : null;
  const cacheHitRatio =
    displayTokens?.cache_read_tokens != null
      ? displayTokens.cache_read_tokens /
        Math.max(
          1,
          (displayTokens.input_tokens ?? 0) +
            (displayTokens.cache_write_tokens ?? 0) +
            displayTokens.cache_read_tokens
        )
      : 0;

  const compositionLabels = useMemo(
    () => ({
      input: t('usageDashboard.tokenInput'),
      output: t('usageDashboard.tokenOutput'),
      cacheWrite: t('usageDashboard.tokenCacheWrite'),
      cacheRead: t('usageDashboard.tokenCacheRead'),
    }),
    [t]
  );

  const renderDimensionDetailCard = useCallback(
    (
      breakdown: DimensionSubBreakdown,
      mode: 'folder' | 'agent' | 'model'
    ) => {
      const primarySubList =
        mode === 'agent' ? breakdown.topFolders : breakdown.topAgents;
      const primarySubListTitle =
        mode === 'agent'
          ? t('usageDashboard.topProjects')
          : t('usageDashboard.topAgents');
      const primarySubListIcon = mode === 'agent' ? FolderOpen : Cpu;
      const primarySubListEmpty =
        mode === 'agent'
          ? t('usageDashboard.noProjectData')
          : t('usageDashboard.noAgentData');

      const secondarySubList =
        mode === 'model' ? breakdown.topFolders : breakdown.topModels;
      const secondarySubListTitle =
        mode === 'model'
          ? t('usageDashboard.topProjects')
          : t('usageDashboard.topModels');
      const secondarySubListIcon = mode === 'model' ? FolderOpen : Hash;
      const secondarySubListEmpty =
        mode === 'model'
          ? t('usageDashboard.noProjectData')
          : t('usageDashboard.noModelData');

      const topAgentItem = breakdown.topAgents[0] ?? null;
      const topModelItem = breakdown.topModels[0] ?? null;

      const summaryTiles: UsageHabitItem[] = [
        {
          id: 'avgDaily',
          icon: Zap,
          label: t('usageDashboard.avgDailyTokenLabel'),
          value: formatOptionalNumber(breakdown.dailyAvgTokens, notProvided),
          badge: t('usageDashboard.activeDaysCount', {
            count: breakdown.activeDaysCount,
          }),
        },
        {
          id: 'totalCost',
          icon: Activity,
          label: t('usageDashboard.totalCost'),
          value: formatOptionalCost(breakdown.totalCost, notProvided),
          badge: t('usageDashboard.sessionsCount', {
            count: breakdown.sessionCount,
          }),
        },
        {
          id: 'topAgent',
          icon: Cpu,
          label: t('usageDashboard.topAgents'),
          value: topAgentItem?.label ?? notProvided,
          badge: topAgentItem
            ? t('usageDashboard.sessionsCount', {
                count: topAgentItem.sessionCount,
              })
            : t('usageDashboard.noAgentData'),
        },
        {
          id: 'topModel',
          icon: Hash,
          label: t('usageDashboard.topModels'),
          value: topModelItem?.label ?? notProvided,
          badge: topModelItem
            ? t('usageDashboard.sessionsCount', {
                count: topModelItem.sessionCount,
              })
            : t('usageDashboard.noModelData'),
        },
      ];

      return (
        <div className="mt-2 rounded-2xl border border-border/75 bg-background/90 p-4 shadow-xs">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {summaryTiles.map((tile) => (
              <UsageHabitTile key={tile.id} item={tile} />
            ))}
          </div>

          <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-3">
            <section className="kanban-usage-card flex min-w-0 flex-col p-3.5">
              <UsageCardHeader
                icon={PieChart}
                title={t('usageDashboard.tokenComposition')}
              />
              <TokenCompositionList
                tokens={breakdown.tokenCounts}
                notProvided={notProvided}
                labels={compositionLabels}
              />
            </section>

            <UsageRankingCard
              title={primarySubListTitle}
              icon={primarySubListIcon}
              emptyLabel={primarySubListEmpty}
              items={primarySubList}
              notProvided={notProvided}
              tokensLabel={t('usageDashboard.tokens')}
              formatSessionsCount={(count) =>
                t('usageDashboard.sessionsCount', { count })
              }
            />

            <UsageRankingCard
              title={secondarySubListTitle}
              icon={secondarySubListIcon}
              emptyLabel={secondarySubListEmpty}
              items={secondarySubList}
              notProvided={notProvided}
              tokensLabel={t('usageDashboard.tokens')}
              formatSessionsCount={(count) =>
                t('usageDashboard.sessionsCount', { count })
              }
            />
          </div>
        </div>
      );
    },
    [compositionLabels, notProvided, t]
  );

  return (
    <div className="kanban-usage-page flex h-full flex-col bg-[#FFFFFF] dark:bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex h-8 items-center gap-2">
          <BarChart3 className="h-5 w-5 shrink-0 text-muted-foreground" />
          <h2 className="m-0 text-base font-semibold leading-none text-foreground">
            {t('usageDashboard.title')}
          </h2>
        </div>

        {activeTab !== 'plan' ? (
          <div className="flex min-w-0 items-center gap-3">
            {statistics?.last_updated ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('usageDashboard.lastUpdated', {
                  time: formatRelativeTime(statistics.last_updated),
                })}
              </span>
            ) : null}
            {statisticsQuery.isFetching && statistics ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" />
                {t('usageDashboard.updating')}
              </span>
            ) : null}

            <AstryxSelect
              value={selectedTarget}
              options={targetOptions}
              onChange={(nextTarget) => {
                startTransition(() => {
                  setSelectedTarget(nextTarget);
                });
              }}
              ariaLabel={t('usageDashboard.currentProject')}
              className="kanban-usage-header-select w-56 shrink-0"
            />

            <div className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[var(--radius)] border border-border/60 bg-muted p-0.5">
              {DATE_RANGE_OPTIONS.map((range) => (
                <button
                  key={range}
                  type="button"
                  className={cn(
                    'inline-flex h-full items-center justify-center rounded-[calc(var(--radius)-2px)] px-3 text-xs font-medium transition-colors',
                    dateRange === range
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => {
                    startTransition(() => {
                      setDateRange(range);
                    });
                  }}
                >
                  {range === '7d'
                    ? t('usageDashboard.range7d')
                    : range === '30d'
                      ? t('usageDashboard.range30d')
                      : t('usageDashboard.rangeAll')}
                </button>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => void statisticsQuery.refetch()}
              disabled={statisticsQuery.isFetching}
              className="h-8 shrink-0 text-xs"
            >
              {t('usageDashboard.refresh')}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="absolute left-10 top-1/2 z-10 -translate-y-1/2">
          <div className="kanban-usage-tab-rail flex flex-col gap-1 px-1 py-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                title={tab.label}
                aria-label={tab.label}
                className={cn(
                  'kanban-usage-tab flex items-center justify-center rounded-md px-2 py-3 transition-colors',
                  activeTab === tab.key ? tab.activeColor : ''
                )}
                onClick={() => setActiveTab(tab.key)}
              >
                <tab.icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 pl-24">
          {activeTab !== 'plan' && failedProviders.length > 0 ? (
            <div className="kanban-usage-message-error mb-4 rounded-lg px-4 py-2.5 text-sm">
              {t('usageDashboard.providerScanFailed', {
                providers: failedProviders.map((p) => p.provider).join(', '),
              })}
            </div>
          ) : null}

          {activeTab !== 'plan' && error ? (
            <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {activeTab !== 'plan' && loading ? (
            <SurfaceLoading label={t('usageDashboard.loading')} />
          ) : null}

          {activeTab !== 'plan' && !loading && !statistics && !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="mb-3 h-10 w-10 opacity-50" />
              <p className="text-base">{t('usageDashboard.noData')}</p>
            </div>
          ) : null}

          {activeTab === 'plan' ? <PlanUsageDashboard /> : null}

          {statistics && activeTab === 'overview' ? (
            <div className="space-y-4">
              <section
                aria-label={t('usageDashboard.summaryRegion')}
                className="kanban-usage-summary"
              >
                <UsageSummaryPrimary
                  title={t('usageDashboard.tokenAndCacheTitle')}
                  icon={Zap}
                  token={
                    <OverviewStat
                      value={formatOptionalNumber(
                        preferredTokenTotal(statistics.total_tokens),
                        notProvided
                      )}
                      detail={
                        preferredTokenTotal(statistics.total_tokens) == null ? (
                          <span className="text-sm text-muted-foreground">
                            {t('usageDashboard.notProvidedReason')}
                          </span>
                        ) : (
                          renderTrend(
                            statistics.weekly_comparison.trends.tokens
                          )
                        )
                      }
                    />
                  }
                  cache={
                    <div className="kanban-usage-summary__cache">
                      <UsageRing
                        ratio={cacheHitRatio}
                        label={t('usageDashboard.cacheHitRate')}
                      />
                    </div>
                  }
                />
                <UsageSummaryMetrics
                  title={t('usageDashboard.statsInfoTitle')}
                  icon={Activity}
                >
                  <OverviewStat
                    compact
                    label={t('usageDashboard.totalCost')}
                    value={formatOptionalCost(
                      statistics.estimated_cost,
                      notProvided
                    )}
                    detail={renderTrend(
                      statistics.weekly_comparison.trends.cost
                    )}
                  />
                  <OverviewStat
                    compact
                    label={t('usageDashboard.totalSessions')}
                    value={statistics.total_sessions}
                    detail={renderTrend(
                      statistics.weekly_comparison.trends.sessions
                    )}
                  />
                  <OverviewStat
                    compact
                    label={t('usageDashboard.avgPerSession')}
                    value={
                      statistics.total_sessions > 0 &&
                      statistics.estimated_cost != null
                        ? formatCost(
                            statistics.estimated_cost /
                              statistics.total_sessions
                          )
                        : notProvided
                    }
                    detail={
                      <span className="text-[11px] text-muted-foreground">
                        {t('usageDashboard.avgTokensPerSession', {
                          value: formatOptionalNumber(
                            statistics.total_sessions > 0
                              ? preferredTokenTotal(statistics.total_tokens) !=
                                null
                                ? (preferredTokenTotal(
                                    statistics.total_tokens
                                  ) ?? 0) / statistics.total_sessions
                                : null
                              : null,
                            notProvided
                          ),
                        })}
                      </span>
                    }
                  />
                  <OverviewStat
                    compact
                    label={t('usageDashboard.activeDays')}
                    value={activeDaysCount}
                    detail={
                      <span className="text-[11px] text-muted-foreground">
                        {t('usageDashboard.daysCount', {
                          count: filteredDailyUsage.length,
                        })}
                      </span>
                    }
                  />
                </UsageSummaryMetrics>
                <UsageHabitsCard
                  title={t('usageDashboard.codingHabits')}
                  icon={UserCheck}
                  items={habitItems}
                />
              </section>

              <div className="kanban-usage-trend-row">
                <section className="kanban-usage-card kanban-usage-trend-row__trend flex min-w-0 flex-col p-4">
                  <UsageCardHeader
                    icon={BarChart3}
                    title={t('usageDashboard.dailyTrend')}
                    right={
                      <span className="text-xs text-muted-foreground">
                        {t('usageDashboard.daysCount', {
                          count: filteredDailyUsage.length,
                        })}
                      </span>
                    }
                  />

                  {filteredDailyUsage.length > 0 ? (
                    <>
                      <div className="flex flex-wrap items-center justify-end gap-4 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-[3px] bg-foreground/75" />
                          {t('usageDashboard.freshTokens')}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-[3px] bg-primary" />
                          {t('usageDashboard.tokenCacheRead')}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="relative inline-flex h-2.5 w-4 items-center justify-center">
                            <span className="h-0.5 w-full rounded-full bg-amber-500" />
                            <span className="absolute h-2 w-2 rounded-full border border-background bg-amber-500" />
                          </span>
                          {t('usageDashboard.trendLine')}
                        </span>
                      </div>

                      <div className="mt-3 flex h-44 min-w-0 flex-1">
                        <div className="flex w-14 shrink-0 flex-col justify-between pb-1 text-right text-[10px] tabular-nums text-muted-foreground">
                          {[1, 0.5, 0].map((ratio) => (
                            <span key={ratio} className="pr-2">
                              {formatNumber(maxDailyTokens * ratio)}
                            </span>
                          ))}
                        </div>
                        <div className="relative min-w-0 flex-1 overflow-x-auto">
                          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between pb-1">
                            {[0, 1, 2].map((line) => (
                              <span
                                key={line}
                                className="block border-t border-dashed border-border/40"
                              />
                            ))}
                          </div>
                          <div
                            className="relative grid h-full items-end gap-1 px-1"
                            style={{
                              gridTemplateColumns: `repeat(${filteredDailyUsage.length}, minmax(10px, 1fr))`,
                              minWidth: `${Math.max(240, filteredDailyUsage.length * 14)}px`,
                            }}
                          >
                            <svg
                              data-testid="usage-trend-line-chart"
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                            >
                              <polyline
                                fill="none"
                                stroke="hsl(var(--warning))"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                vectorEffect="non-scaling-stroke"
                                points={trendPolylinePointsAttr}
                              />
                            </svg>

                            {filteredDailyUsage.map((day) => {
                              const totalTokens =
                                preferredTokenTotal(day.tokens) ?? 0;
                              const cacheReadTokens = Math.min(
                                totalTokens,
                                Math.max(
                                  0,
                                  preferredTokenCounts(day.tokens)
                                    ?.cache_read_tokens ?? 0
                                )
                              );
                              const freshTokens = Math.max(
                                0,
                                totalTokens - cacheReadTokens
                              );
                              const totalHeight =
                                (totalTokens / maxDailyTokens) * 100;
                              const barHeightPct = Math.max(
                                totalTokens > 0 ? 2 : 0,
                                totalHeight
                              );
                              const showTooltip = (
                                element: HTMLButtonElement
                              ) => {
                                const rect = element.getBoundingClientRect();
                                setTooltip({
                                  visible: true,
                                  x: rect.left + rect.width / 2,
                                  y: rect.top,
                                  content: {
                                    date: day.date,
                                    cost: day.cost ?? null,
                                    sessions: day.sessions,
                                    totalTokens,
                                    freshTokens,
                                    cacheReadTokens,
                                  },
                                });
                              };

                              return (
                                <button
                                  key={day.date}
                                  type="button"
                                  className="group relative flex h-full min-w-0 items-end focus-visible:outline-none"
                                  aria-label={t('usageDashboard.dailyBarAria', {
                                    date: formatShortDate(day.date),
                                    value: formatNumber(totalTokens),
                                  })}
                                  onFocus={(event) =>
                                    showTooltip(event.currentTarget)
                                  }
                                  onBlur={() =>
                                    setTooltip((prev) => ({
                                      ...prev,
                                      visible: false,
                                    }))
                                  }
                                  onMouseEnter={(event) =>
                                    showTooltip(event.currentTarget)
                                  }
                                  onMouseLeave={() =>
                                    setTooltip((prev) => ({
                                      ...prev,
                                      visible: false,
                                    }))
                                  }
                                >
                                  <span
                                    className="pointer-events-none absolute inset-y-0 left-1/2 w-full -translate-x-1/2 rounded-t-[4px] bg-foreground/0 transition-colors group-hover:bg-foreground/[0.06]"
                                    aria-hidden="true"
                                  />
                                  <span
                                    className="relative flex w-full min-w-[6px] flex-col-reverse overflow-hidden rounded-t-[3px] ring-primary transition-[filter,box-shadow] duration-200 group-hover:brightness-110 group-focus-visible:ring-2 motion-reduce:transition-none"
                                    style={{
                                      height: `${barHeightPct}%`,
                                    }}
                                  >
                                    <span
                                      className="block bg-primary"
                                      style={{
                                        height: `${totalTokens > 0 ? (cacheReadTokens / totalTokens) * 100 : 0}%`,
                                      }}
                                    />
                                    <span
                                      className="block bg-foreground/75"
                                      style={{
                                        height: `${totalTokens > 0 ? (freshTokens / totalTokens) * 100 : 0}%`,
                                      }}
                                    />
                                  </span>
                                  <span
                                    aria-hidden="true"
                                    className="pointer-events-none absolute left-1/2 z-20 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full border border-background bg-[hsl(var(--warning))] shadow-xs transition-transform duration-150 group-hover:scale-125"
                                    style={{
                                      bottom: `${Math.min(98, Math.max(totalTokens > 0 ? 3 : 1, totalHeight))}%`,
                                    }}
                                  />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div
                        className={
                          filteredDailyUsage.length < 2
                            ? 'ml-12 mt-1 flex justify-center'
                            : 'ml-12 mt-1 flex justify-between'
                        }
                      >
                        <span className="text-[9px] text-muted-foreground">
                          {formatShortDate(filteredDailyUsage[0].date)}
                        </span>
                        {filteredDailyUsage.length > 2 ? (
                          <span className="text-[9px] text-muted-foreground">
                            {formatShortDate(
                              filteredDailyUsage[
                                Math.floor(filteredDailyUsage.length / 2)
                              ].date
                            )}
                          </span>
                        ) : null}
                        {filteredDailyUsage.length > 1 ? (
                          <span className="text-[9px] text-muted-foreground">
                            {formatShortDate(
                              filteredDailyUsage[filteredDailyUsage.length - 1]
                                .date
                            )}
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 items-center justify-center py-12 text-xs text-muted-foreground">
                      {t('usageDashboard.noData')}
                    </div>
                  )}
                </section>

                <section className="kanban-usage-card flex min-w-0 flex-col p-4">
                  <UsageCardHeader
                    icon={PieChart}
                    title={t('usageDashboard.tokenComposition')}
                    description={t('usageDashboard.tokenCompositionHint')}
                  />
                  <TokenCompositionList
                    tokens={displayTokens}
                    notProvided={notProvided}
                    labels={compositionLabels}
                  />
                </section>
              </div>

              <OverviewSubscriptionPlansCard />

              <div className="grid items-stretch gap-4 lg:grid-cols-2">
                <UsageRankingCard
                  title={t('usageDashboard.topModels')}
                  icon={Hash}
                  emptyLabel={t('usageDashboard.noModelData')}
                  items={topModels}
                  notProvided={notProvided}
                  tokensLabel={t('usageDashboard.tokens')}
                  formatSessionsCount={(count) =>
                    t('usageDashboard.sessionsCount', { count })
                  }
                />

                <section className="kanban-usage-card flex min-w-0 flex-col p-4">
                  <UsageCardHeader
                    icon={Flame}
                    title={t('usageDashboard.activityHeatmap')}
                    description={t('usageDashboard.heatmapHint')}
                  />
                  <UsageHeatmap sessions={statistics.sessions} />
                </section>
              </div>

              <div className="grid items-stretch gap-4 lg:grid-cols-2">
                <UsageRankingCard
                  title={t('usageDashboard.topProjects')}
                  icon={FolderOpen}
                  emptyLabel={t('usageDashboard.noProjectData')}
                  items={topProjects}
                  notProvided={notProvided}
                  tokensLabel={t('usageDashboard.tokens')}
                  formatSessionsCount={(count) =>
                    t('usageDashboard.sessionsCount', { count })
                  }
                />

                <UsageRankingCard
                  title={t('usageDashboard.topAgents')}
                  icon={Cpu}
                  emptyLabel={t('usageDashboard.noAgentData')}
                  items={topAgents}
                  notProvided={notProvided}
                  tokensLabel={t('usageDashboard.tokens')}
                  formatSessionsCount={(count) =>
                    t('usageDashboard.sessionsCount', { count })
                  }
                />
              </div>
            </div>
          ) : null}

          {statistics && activeTab === 'folders' ? (
            <section className="kanban-usage-card p-4">
              <UsageCardHeader
                icon={FolderOpen}
                title={t('usageDashboard.byFolderTitle')}
                right={
                  <span className="text-xs text-muted-foreground">
                    {t('usageDashboard.itemsCount', {
                      count: statistics.by_folder.length,
                    })}
                  </span>
                }
              />
              {statistics.by_folder.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <FolderOpen className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noFolderData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_folder.map((folder, index) => {
                    const isExpanded = expandedFolderId === folder.workspace_id;
                    const projectName = resolveProjectName(
                      folder.folder,
                      folder.workspace_id
                    );
                    const folderPath = folder.folder || folder.workspace_id;
                    const folderSessions = statistics.sessions.filter(
                      (session) => session.workspace_id === folder.workspace_id
                    );
                    const folderBreakdown = isExpanded
                      ? buildDimensionSubBreakdown(
                          folderSessions,
                          folder.tokens,
                          folder.cost,
                          folder.session_count,
                          notProvided,
                          resolveProjectName
                        )
                      : null;

                    return (
                      <div key={folder.workspace_id}>
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedFolderId((prev) =>
                              prev === folder.workspace_id
                                ? null
                                : folder.workspace_id
                            )
                          }
                          className={cn(
                            'flex min-h-12 w-full items-center gap-3 rounded-full border border-border/60 bg-muted/30 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            isExpanded && 'border-primary/40 bg-muted/50'
                          )}
                        >
                          <span
                            className={cn(
                              'w-5 shrink-0 text-center text-sm font-bold tabular-nums',
                              index === 0 && 'kanban-rank-first',
                              index === 1 && 'kanban-rank-second',
                              index === 2 && 'kanban-rank-third',
                              index >= 3 && 'text-muted-foreground'
                            )}
                          >
                            {index + 1}
                          </span>

                          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {projectName}
                            </span>
                            <span
                              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                              title={folderPath}
                            >
                              {folderPath}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <UsageRankingMetricPill
                              value={formatOptionalCost(
                                folder.cost,
                                notProvided
                              )}
                            />
                            <UsageRankingMetricPill
                              value={`${formatOptionalNumber(
                                preferredTokenTotal(folder.tokens),
                                notProvided
                              )} ${t('usageDashboard.tokens')}`}
                            />
                            <UsageRankingMetricPill
                              value={t('usageDashboard.sessionsCount', {
                                count: folder.session_count,
                              })}
                            />
                            {isExpanded ? (
                              <ChevronDown className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                        </button>

                        {isExpanded && folderBreakdown
                          ? renderDimensionDetailCard(
                              folderBreakdown,
                              'folder'
                            )
                          : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {statistics && activeTab === 'agents' ? (
            <section className="kanban-usage-card p-4">
              <UsageCardHeader
                icon={Zap}
                title={t('usageDashboard.byAgentTitle')}
                right={
                  <span className="text-xs text-muted-foreground">
                    {t('usageDashboard.itemsCount', {
                      count: statistics.by_agent.length,
                    })}
                  </span>
                }
              />
              {statistics.by_agent.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Zap className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noAgentData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_agent.map((agent, index) => {
                    const isExpanded = expandedAgentId === agent.agent_id;
                    const agentSessions = statistics.sessions.filter(
                      (session) =>
                        (session.agent_id ?? 'unprovided') === agent.agent_id
                    );
                    const agentBreakdown = isExpanded
                      ? buildDimensionSubBreakdown(
                          agentSessions,
                          agent.tokens,
                          agent.cost,
                          agent.session_count,
                          notProvided,
                          resolveProjectName
                        )
                      : null;

                    return (
                      <div key={agent.agent_id}>
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedAgentId((prev) =>
                              prev === agent.agent_id ? null : agent.agent_id
                            )
                          }
                          className={cn(
                            'flex min-h-12 w-full items-center gap-3 rounded-full border border-border/60 bg-muted/30 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            isExpanded && 'border-primary/40 bg-muted/50'
                          )}
                        >
                          <span
                            className={cn(
                              'w-5 shrink-0 text-center text-sm font-bold tabular-nums',
                              index === 0 && 'kanban-rank-first',
                              index === 1 && 'kanban-rank-second',
                              index === 2 && 'kanban-rank-third',
                              index >= 3 && 'text-muted-foreground'
                            )}
                          >
                            {index + 1}
                          </span>

                          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {displayUsageLabel(agent.agent_id, notProvided)}
                            </span>
                            {preferredTokenCounts(agent.tokens) == null ? (
                              <span className="truncate text-xs text-muted-foreground">
                                {t('usageDashboard.notProvidedReason')}
                              </span>
                            ) : null}
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <UsageRankingMetricPill
                              value={formatOptionalCost(
                                agent.cost,
                                notProvided
                              )}
                            />
                            <UsageRankingMetricPill
                              value={`${formatOptionalNumber(
                                preferredTokenTotal(agent.tokens),
                                notProvided
                              )} ${t('usageDashboard.tokens')}`}
                            />
                            <UsageRankingMetricPill
                              value={t('usageDashboard.sessionsCount', {
                                count: agent.session_count,
                              })}
                            />
                            {isExpanded ? (
                              <ChevronDown className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                        </button>

                        {isExpanded && agentBreakdown
                          ? renderDimensionDetailCard(agentBreakdown, 'agent')
                          : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {statistics && activeTab === 'models' ? (
            <section className="kanban-usage-card p-4">
              <UsageCardHeader
                icon={Hash}
                title={t('usageDashboard.byModelTitle')}
                right={
                  <span className="text-xs text-muted-foreground">
                    {t('usageDashboard.itemsCount', {
                      count: statistics.by_model.length,
                    })}
                  </span>
                }
              />
              {statistics.by_model.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Hash className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noModelData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_model.map((model, index) => {
                    const isExpanded = expandedModelId === model.model;
                    const modelCounts = preferredTokenCounts(model.tokens);
                    const modelSessions = statistics.sessions.filter(
                      (session) =>
                        (session.model ?? 'unprovided') === model.model
                    );
                    const modelBreakdown = isExpanded
                      ? buildDimensionSubBreakdown(
                          modelSessions,
                          model.tokens,
                          model.cost,
                          model.session_count,
                          notProvided,
                          resolveProjectName
                        )
                      : null;

                    return (
                      <div key={model.model}>
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedModelId((prev) =>
                              prev === model.model ? null : model.model
                            )
                          }
                          className={cn(
                            'flex min-h-12 w-full items-center gap-3 rounded-full border border-border/60 bg-muted/30 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            isExpanded && 'border-primary/40 bg-muted/50'
                          )}
                        >
                          <span
                            className={cn(
                              'w-5 shrink-0 text-center text-sm font-bold tabular-nums',
                              index === 0 && 'kanban-rank-first',
                              index === 1 && 'kanban-rank-second',
                              index === 2 && 'kanban-rank-third',
                              index >= 3 && 'text-muted-foreground'
                            )}
                          >
                            {index + 1}
                          </span>

                          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {displayUsageLabel(model.model, notProvided)}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {t('usageDashboard.modelInput', {
                                value: formatOptionalNumber(
                                  modelCounts?.input_tokens,
                                  notProvided
                                ),
                              })}
                              {' · '}
                              {t('usageDashboard.modelOutput', {
                                value: formatOptionalNumber(
                                  modelCounts?.output_tokens,
                                  notProvided
                                ),
                              })}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <UsageRankingMetricPill
                              value={formatOptionalCost(
                                model.cost,
                                notProvided
                              )}
                            />
                            <UsageRankingMetricPill
                              value={`${formatOptionalNumber(
                                preferredTokenTotal(model.tokens),
                                notProvided
                              )} ${t('usageDashboard.tokens')}`}
                            />
                            <UsageRankingMetricPill
                              value={t('usageDashboard.sessionsCount', {
                                count: model.session_count,
                              })}
                            />
                            {isExpanded ? (
                              <ChevronDown className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                        </button>

                        {isExpanded && modelBreakdown
                          ? renderDimensionDetailCard(modelBreakdown, 'model')
                          : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {statistics && activeTab === 'sessions' ? (
            <section className="kanban-usage-card p-4">
              <UsageCardHeader
                icon={List}
                title={t('usageDashboard.sessionListTitle', {
                  count: filteredSessions.length,
                })}
                right={
                  <div className="inline-flex h-7 items-center gap-0.5 rounded-[var(--radius)] border border-border/60 bg-muted p-0.5">
                    <button
                      type="button"
                      className={cn(
                        'inline-flex h-full items-center justify-center rounded-[calc(var(--radius)-2px)] px-2.5 text-xs font-medium transition-colors',
                        sessionSortBy === 'cost'
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setSessionSortBy('cost')}
                    >
                      {t('usageDashboard.sortByCost')}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex h-full items-center justify-center rounded-[calc(var(--radius)-2px)] px-2.5 text-xs font-medium transition-colors',
                        sessionSortBy === 'time'
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setSessionSortBy('time')}
                    >
                      {t('usageDashboard.sortByTime')}
                    </button>
                  </div>
                }
              />

              {paginatedSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <List className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {paginatedSessions.map((session, index) => {
                    const rankIndex =
                      (sessionPage - 1) * SESSIONS_PER_PAGE + index;
                    const projectLabel = resolveProjectName(
                      session.folder,
                      session.workspace_id
                    );
                    return (
                      <div
                        key={session.session_id}
                        className="flex min-h-12 items-center gap-3 rounded-full border border-border/60 bg-muted/30 px-4 py-2 transition-colors hover:bg-muted/50"
                      >
                        <span
                          className={cn(
                            'w-5 shrink-0 text-center text-sm font-bold tabular-nums',
                            rankIndex === 0 && 'kanban-rank-first',
                            rankIndex === 1 && 'kanban-rank-second',
                            rankIndex === 2 && 'kanban-rank-third',
                            rankIndex >= 3 && 'text-muted-foreground'
                          )}
                        >
                          {rankIndex + 1}
                        </span>

                        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <span
                            className="truncate text-sm font-semibold text-foreground"
                            title={session.summary || session.session_id}
                          >
                            {session.summary || session.session_id}
                          </span>
                          <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                            <span>{formatDate(session.timestamp)}</span>
                            <span>·</span>
                            <span>{projectLabel}</span>
                            {session.agent_id ? (
                              <>
                                <span>·</span>
                                <span>
                                  {displayUsageLabel(
                                    session.agent_id,
                                    notProvided
                                  )}
                                </span>
                              </>
                            ) : null}
                          </span>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <UsageRankingMetricPill
                            value={formatOptionalCost(
                              session.cost,
                              notProvided
                            )}
                          />
                          <UsageRankingMetricPill
                            value={`${formatOptionalNumber(
                              preferredTokenTotal(session.tokens),
                              notProvided
                            )} ${t('usageDashboard.tokens')}`}
                          />
                          <UsageRankingMetricPill
                            value={displayUsageLabel(
                              session.model,
                              notProvided
                            )}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {totalPages > 1 ? (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPage((prev) => Math.max(1, prev - 1))
                    }
                    disabled={sessionPage === 1}
                    className="raised-control px-3 py-1 text-xs disabled:opacity-50"
                  >
                    {t('usageDashboard.prevPage')}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {sessionPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPage((prev) => Math.min(totalPages, prev + 1))
                    }
                    disabled={sessionPage === totalPages}
                    className="raised-control px-3 py-1 text-xs disabled:opacity-50"
                  >
                    {t('usageDashboard.nextPage')}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      {tooltip.visible ? (
        <div
          role="tooltip"
          data-testid="usage-trend-tooltip"
          className="pointer-events-none fixed z-50 min-w-[196px] -translate-x-1/2 -translate-y-full rounded-xl border border-border/80 bg-popover px-3.5 py-2.5 text-popover-foreground shadow-lg"
          style={{
            left: tooltip.x,
            top: Math.max(12, tooltip.y - 10),
          }}
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-xs font-semibold text-foreground">
              {formatTrendTooltipDate(tooltip.content.date, weekdayLabels)}
            </span>
            <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
              {formatNumber(tooltip.content.totalTokens)}
            </span>
          </div>

          <div className="mt-2 space-y-1 text-[11px]">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary" />
                {t('usageDashboard.tokenCacheRead')}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatNumber(tooltip.content.cacheReadTokens)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-foreground/75" />
                {t('usageDashboard.freshTokens')}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatNumber(tooltip.content.freshTokens)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2.5 shrink-0 rounded-full bg-[hsl(var(--warning))]" />
                {t('usageDashboard.trendLine')}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatNumber(tooltip.content.totalTokens)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4 pt-0.5">
              <span className="text-muted-foreground">
                {t('usageDashboard.costLabel')}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatOptionalCost(tooltip.content.cost, notProvided)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('usageDashboard.sessionsLabel')}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {tooltip.content.sessions}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
