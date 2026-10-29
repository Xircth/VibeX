import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Clock,
  Cpu,
  Flame,
  FolderOpen,
  Hash,
  PieChart,
  UserCheck,
  Zap,
} from 'lucide-react';
import type { AgentManagementView } from 'shared/types';
import type { ProjectUsageDailyUsage, ProjectUsageStatistics } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { UsageHabitItem, UsageRankingItem } from './types';
import {
  OverviewStat,
  TokenCompositionList,
  UsageCardHeader,
  UsageHabitsCard,
  UsageRankingCard,
  UsageRing,
  UsageSummaryMetrics,
  UsageSummaryPrimary,
} from './UsageCards';
import { OverviewSubscriptionPlansCard } from './OverviewSubscriptionPlansCard';
import { UsageDailyTrend } from './UsageDailyTrend';
import { UsageHeatmap } from './UsageHeatmap';
import {
  displayUsageLabel,
  formatCost,
  formatOptionalCost,
  formatOptionalNumber,
} from './usageFormat';
import { favoriteAgentPresentation } from './FavoriteAgentView';
import { preferredTokenCounts, preferredTokenTotal } from './usageModel';

export function UsageOverviewPanel({
  statistics,
  catalogAgents,
  filteredDailyUsage,
  maxDailyTokens,
  notProvided,
}: {
  statistics: ProjectUsageStatistics;
  catalogAgents: AgentManagementView[];
  filteredDailyUsage: ProjectUsageDailyUsage[];
  maxDailyTokens: number;
  notProvided: string;
}) {
  const { t } = useTranslation(['tasks', 'common']);

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

  const favoriteAgentView = useMemo(
    () =>
      favoriteAgent
        ? favoriteAgentPresentation(
            favoriteAgent.agent_id,
            catalogAgents,
            notProvided
          )
        : null,
    [catalogAgents, favoriteAgent, notProvided]
  );

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
      },
      {
        id: 'favoriteAgent',
        icon: Cpu,
        label: t('usageDashboard.favoriteAgent'),
        value: favoriteAgentView?.node ?? notProvided,
        valueTitle: favoriteAgentView?.title ?? notProvided,
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
      favoriteAgentView,
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

  return (
    <div className="space-y-4">
      <section
        aria-label={t('usageDashboard.summaryRegion')}
        className="kanban-usage-summary"
        data-basic-guide="usage-overview-cards"
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
                  renderTrend(statistics.weekly_comparison.trends.tokens)
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
            value={formatOptionalCost(statistics.estimated_cost, notProvided)}
            detail={renderTrend(statistics.weekly_comparison.trends.cost)}
          />
          <OverviewStat
            compact
            label={t('usageDashboard.totalSessions')}
            value={statistics.total_sessions}
            detail={renderTrend(statistics.weekly_comparison.trends.sessions)}
          />
          <OverviewStat
            compact
            label={t('usageDashboard.avgPerSession')}
            value={
              statistics.total_sessions > 0 && statistics.estimated_cost != null
                ? formatCost(
                    statistics.estimated_cost / statistics.total_sessions
                  )
                : notProvided
            }
            detail={
              <span className="text-xs text-muted-foreground">
                {t('usageDashboard.avgTokensPerSession', {
                  value: formatOptionalNumber(
                    statistics.total_sessions > 0
                      ? preferredTokenTotal(statistics.total_tokens) != null
                        ? (preferredTokenTotal(statistics.total_tokens) ?? 0) /
                          statistics.total_sessions
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
              <span className="text-xs text-muted-foreground">
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
        <UsageDailyTrend
          filteredDailyUsage={filteredDailyUsage}
          maxDailyTokens={maxDailyTokens}
          notProvided={notProvided}
          weekdayLabels={weekdayLabels}
        />
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

      <OverviewSubscriptionPlansCard agents={catalogAgents} />

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
  );
}
