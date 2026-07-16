import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  CreditCard,
  MessageSquare,
  Hash,
  TrendingUp,
  BarChart3,
  List,
  FolderOpen,
  ChevronDown,
  X,
  Clock,
  Zap,
  Package,
} from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import {
  localUsageApi,
  type ProjectUsageDailyUsage,
  type ProjectUsageStatistics,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { PlanUsageDashboard } from '@/components/kanban/PlanUsageDashboard';

type UsageTab = 'overview' | 'models' | 'sessions' | 'plan';
type DateRange = '7d' | '30d' | 'all';

const SESSIONS_PER_PAGE = 15;
const DATE_RANGE_OPTIONS: DateRange[] = ['7d', '30d', 'all'];
const USAGE_STATS_STALE_TIME_MS = 2 * 60_000;
const USAGE_STATS_GC_TIME_MS = 10 * 60_000;

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
  const queryClient = useQueryClient();
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
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: { date: string; cost: number; sessions: number };
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: { date: '', cost: 0, sessions: 0 },
  });
  const availableTargets = useMemo(
    () => (projectId ? [preferredProjectTarget, 'global'] : ['global']),
    [preferredProjectTarget, projectId]
  );

  const statisticsQuery = useQuery({
    ...getUsageStatisticsQueryOptions(selectedTarget, dateRange),
    enabled: activeTab !== 'plan',
  });

  const statistics = statisticsQuery.data ?? null;
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
    if (availableTargets.length === 0) {
      return;
    }

    const prefetches = availableTargets.flatMap((target) =>
      DATE_RANGE_OPTIONS.map((range) =>
        queryClient.prefetchQuery(getUsageStatisticsQueryOptions(target, range))
      )
    );

    void Promise.allSettled(prefetches);
  }, [availableTargets, queryClient]);

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

  const filteredSessions = useMemo(() => {
    const source = statistics?.sessions ?? [];
    return source.slice().sort((left, right) => {
      if (sessionSortBy === 'cost') {
        return right.cost - left.cost;
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

  const maxDailyCost = useMemo(
    () => Math.max(1, ...filteredDailyUsage.map((day) => day.cost)),
    [filteredDailyUsage]
  );

  const chartPath = useMemo(() => {
    if (filteredDailyUsage.length < 2) return '';

    const points = filteredDailyUsage.map((day, index) => {
      const x = (index / (filteredDailyUsage.length - 1)) * 100;
      const y = 100 - (maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0);
      return `${x},${y}`;
    });

    return `M ${points.join(' L ')}`;
  }, [filteredDailyUsage, maxDailyCost]);

  const getTokenPercentage = useCallback(
    (value: number): number => {
      if (!statistics || statistics.total_usage.total_tokens === 0) return 0;
      return (value / statistics.total_usage.total_tokens) * 100;
    },
    [statistics]
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

  const selectedProjectName =
    selectedTarget === 'global'
      ? t('usageDashboard.global')
      : (projects.find((project) => `project:${project.id}` === selectedTarget)
          ?.name ?? t('usageDashboard.currentProject'));

  const topModels = statistics?.by_model.slice(0, 5) ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">
            {t('usageDashboard.title')}
          </h2>
        </div>

        {noticeVisible && activeTab !== 'plan' ? (
          <div className="kanban-usage-message-warning flex items-center gap-1.5 rounded-md px-2 py-1 text-xs">
            <span className="text-[10px]">{t('usageDashboard.noticeTag')}</span>
            <span>
              {statistics?.pricing_notice ??
                t('usageDashboard.pricingNoticeDefault')}
            </span>
            <button
              type="button"
              onClick={() => setNoticeVisible(false)}
              className="ml-0.5 rounded p-0.5 transition-colors hover:bg-[var(--surface-control-hover)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}

        <div className="flex-1" />

        {activeTab !== 'plan' ? (
          <>
            <div className="relative">
              <select
                value={selectedTarget}
                onChange={(event) => {
                  const nextTarget = event.target.value;
                  startTransition(() => {
                    setSelectedTarget(nextTarget);
                  });
                }}
                className="h-7 appearance-none rounded-lg border border-border bg-background px-3 pr-7 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="global">{t('usageDashboard.global')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={`project:${project.id}`}>
                    {project.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>

            <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
              {DATE_RANGE_OPTIONS.map((range) => (
                <button
                  key={range}
                  type="button"
                  className={cn(
                    'rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors',
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

            <button
              type="button"
              onClick={() => void statisticsQuery.refetch()}
              disabled={statisticsQuery.isFetching}
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              title={t('usageDashboard.refresh')}
            >
              <RefreshCw
                className={cn(
                  'h-4 w-4',
                  statisticsQuery.isFetching && 'animate-spin'
                )}
              />
            </button>
          </>
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
          {activeTab === 'plan' ? <PlanUsageDashboard /> : null}

          {activeTab !== 'plan' ? (
            <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              <span>{selectedProjectName}</span>
              {statistics?.last_updated ? (
                <>
                  <span className="text-border">•</span>
                  <span>
                    {t('usageDashboard.lastUpdated', {
                      time: formatRelativeTime(statistics.last_updated),
                    })}
                  </span>
                </>
              ) : null}
              {statisticsQuery.isFetching && statistics ? (
                <>
                  <span className="text-border">•</span>
                  <span className="flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    {t('usageDashboard.updating')}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

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
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-base">{t('usageDashboard.loading')}</span>
            </div>
          ) : null}

          {activeTab !== 'plan' && !loading && !statistics && !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="mb-3 h-10 w-10 opacity-50" />
              <p className="text-base">{t('usageDashboard.noData')}</p>
            </div>
          ) : null}

          {statistics && activeTab === 'overview' ? (
            <div className="space-y-5">
              <div className="flex gap-4">
                <div className="grid flex-1 grid-cols-2 gap-4">
                  <div className="kanban-usage-card kanban-usage-card--pink p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-[color:var(--usage-pink-fg)]" />
                      <span className="text-sm text-muted-foreground">
                        {t('usageDashboard.totalCost')}
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {formatCost(statistics.estimated_cost)}
                    </div>
                    <div className="mt-1">
                      {renderTrend(statistics.weekly_comparison.trends.cost)}
                    </div>
                  </div>

                  <div className="kanban-usage-card kanban-usage-card--blue p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <MessageSquare className="h-5 w-5 text-[color:var(--usage-blue-fg)]" />
                      <span className="text-sm text-muted-foreground">
                        {t('usageDashboard.totalSessions')}
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {statistics.total_sessions}
                    </div>
                    <div className="mt-1">
                      {renderTrend(
                        statistics.weekly_comparison.trends.sessions
                      )}
                    </div>
                  </div>

                  <div className="kanban-usage-card kanban-usage-card--green p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Hash className="h-5 w-5 text-[color:var(--usage-green-fg)]" />
                      <span className="text-sm text-muted-foreground">
                        {t('usageDashboard.totalTokens')}
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {formatNumber(statistics.total_usage.total_tokens)}
                    </div>
                    <div className="mt-1">
                      {renderTrend(statistics.weekly_comparison.trends.tokens)}
                    </div>
                  </div>

                  <div className="kanban-usage-card kanban-usage-card--red p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <TrendingUp className="h-5 w-5 text-[color:var(--usage-red-fg)]" />
                      <span className="text-sm text-muted-foreground">
                        {t('usageDashboard.avgPerSession')}
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {statistics.total_sessions > 0
                        ? formatCost(
                            statistics.estimated_cost /
                              statistics.total_sessions
                          )
                        : '$0.0000'}
                    </div>
                  </div>
                </div>

                {filteredDailyUsage.length > 0 ? (
                  <div className="kanban-usage-card flex-1 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-sm font-medium text-muted-foreground">
                        {t('usageDashboard.dailyTrend')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('usageDashboard.daysCount', {
                          count: filteredDailyUsage.length,
                        })}
                      </span>
                    </div>

                    <div className="relative h-40">
                      <div className="absolute inset-y-0 left-0 flex w-14 flex-col justify-between py-1">
                        {[1, 0.5, 0].map((ratio) => (
                          <span
                            key={ratio}
                            className="pr-1 text-right text-xs text-muted-foreground"
                          >
                            {formatCost(maxDailyCost * ratio)}
                          </span>
                        ))}
                      </div>

                      <div className="absolute inset-y-0 left-12 right-0">
                        <div className="absolute inset-0">
                          {[0, 50, 100].map((percent) => (
                            <div
                              key={percent}
                              className="absolute inset-x-0 border-t border-dashed border-border/30"
                              style={{ bottom: `${percent}%` }}
                            />
                          ))}
                        </div>

                        <svg
                          className="absolute inset-0 h-full w-full"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                        >
                          <defs>
                            <linearGradient
                              id="areaGradient"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="1"
                            >
                              {/* var() 在 SVG presentation attribute 中无效，必须走 style */}
                              <stop
                                offset="0%"
                                style={{
                                  stopColor: 'hsl(var(--primary))',
                                  stopOpacity: 0.2,
                                }}
                              />
                              <stop
                                offset="100%"
                                style={{
                                  stopColor: 'hsl(var(--primary))',
                                  stopOpacity: 0.02,
                                }}
                              />
                            </linearGradient>
                          </defs>

                          {chartPath ? (
                            <path
                              d={`${chartPath} L 100,100 L 0,100 Z`}
                              fill="url(#areaGradient)"
                            />
                          ) : null}
                          {chartPath ? (
                            <path
                              d={chartPath}
                              fill="none"
                              style={{ stroke: 'hsl(var(--primary))' }}
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          ) : null}

                          {filteredDailyUsage.map((day, index) => {
                            const singlePoint = filteredDailyUsage.length < 2;
                            const x = singlePoint
                              ? 50
                              : (index / (filteredDailyUsage.length - 1)) * 100;
                            const y =
                              100 -
                              (maxDailyCost > 0
                                ? (day.cost / maxDailyCost) * 100
                                : 0);

                            return (
                              <circle
                                key={day.date}
                                cx={x}
                                cy={y}
                                r="2"
                                style={{ fill: 'hsl(var(--primary))' }}
                                className={
                                  singlePoint
                                    ? 'cursor-pointer'
                                    : 'cursor-pointer opacity-0 transition-opacity hover:opacity-100'
                                }
                                onMouseEnter={(event) => {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  setTooltip({
                                    visible: true,
                                    x: rect.left + rect.width / 2,
                                    y: rect.top,
                                    content: {
                                      date: day.date,
                                      cost: day.cost,
                                      sessions: day.sessions,
                                    },
                                  });
                                }}
                                onMouseLeave={() =>
                                  setTooltip((prev) => ({
                                    ...prev,
                                    visible: false,
                                  }))
                                }
                              />
                            );
                          })}
                        </svg>
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
                  </div>
                ) : null}
              </div>

              <div className="kanban-usage-card p-5">
                <h4 className="mb-4 text-base font-medium text-foreground">
                  {t('usageDashboard.tokenComposition')}
                </h4>
                <div className="space-y-4">
                  {[
                    {
                      id: 'input',
                      label: t('usageDashboard.tokenInput'),
                      value: statistics.total_usage.input_tokens,
                      color: 'kanban-usage-progress-primary',
                    },
                    {
                      id: 'output',
                      label: t('usageDashboard.tokenOutput'),
                      value: statistics.total_usage.output_tokens,
                      color: 'kanban-usage-progress-success',
                    },
                    {
                      id: 'cacheWrite',
                      label: t('usageDashboard.tokenCacheWrite'),
                      value: statistics.total_usage.cache_write_tokens,
                      color: 'kanban-usage-progress-warning',
                    },
                    {
                      id: 'cacheRead',
                      label: t('usageDashboard.tokenCacheRead'),
                      value: statistics.total_usage.cache_read_tokens,
                      color: 'kanban-usage-progress-running',
                    },
                  ].map((item) => (
                    <div key={item.id}>
                      <div className="mb-1.5 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {item.label}
                        </span>
                        <span className="font-medium text-foreground">
                          {formatNumber(item.value)}
                        </span>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-[width] duration-500',
                            item.color
                          )}
                          style={{
                            width: `${getTokenPercentage(item.value)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {topModels.length > 0 ? (
                <div className="kanban-usage-card p-5">
                  <h4 className="mb-4 text-base font-medium text-foreground">
                    {t('usageDashboard.topModels')}
                  </h4>
                  <div className="space-y-2.5">
                    {topModels.map((model, index) => (
                      <div
                        key={model.model}
                        className="flex items-center gap-3 rounded-lg bg-muted/30 p-3"
                      >
                        <span
                          className={cn(
                            'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold',
                            index === 0 && 'kanban-rank-first',
                            index === 1 && 'bg-muted text-muted-foreground',
                            index === 2 && 'kanban-rank-third',
                            index >= 3 && 'bg-muted text-muted-foreground'
                          )}
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {model.model}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatCost(model.total_cost)} ·{' '}
                            {formatNumber(model.total_tokens)} tokens
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('usageDashboard.sessionsCount', {
                            count: model.session_count,
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {statistics && activeTab === 'models' ? (
            <div>
              <h4 className="mb-4 text-sm font-medium text-foreground">
                {t('usageDashboard.byModelTitle')}
              </h4>
              {statistics.by_model.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Hash className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noModelData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_model.map((model) => (
                    <div
                      key={model.model}
                      className="kanban-usage-card group p-4 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                          <Zap className="h-5 w-5 text-primary" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {model.model}
                            </span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              {t('usageDashboard.sessionsCount', {
                                count: model.session_count,
                              })}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
                            <span>
                              {t('usageDashboard.modelInput', {
                                value: formatNumber(model.input_tokens),
                              })}
                            </span>
                            <span>
                              {t('usageDashboard.modelOutput', {
                                value: formatNumber(model.output_tokens),
                              })}
                            </span>
                            <span>
                              {t('usageDashboard.modelTotalTokens', {
                                value: formatNumber(model.total_tokens),
                              })}
                            </span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-lg font-bold text-foreground">
                            {formatCost(model.total_cost)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {t('usageDashboard.avgCostPerSession', {
                              cost: formatCost(
                                model.total_cost /
                                  Math.max(1, model.session_count)
                              ),
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {statistics && activeTab === 'sessions' ? (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h4 className="text-sm font-medium text-foreground">
                  {t('usageDashboard.sessionListTitle', {
                    count: filteredSessions.length,
                  })}
                </h4>
                <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
                  <button
                    type="button"
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
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
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      sessionSortBy === 'time'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setSessionSortBy('time')}
                  >
                    {t('usageDashboard.sortByTime')}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {paginatedSessions.map((session, index) => (
                  <div
                    key={session.session_id}
                    className="kanban-usage-card group p-4 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground">
                        {(sessionPage - 1) * SESSIONS_PER_PAGE + index + 1}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {session.summary || session.session_id}
                            </div>
                            {session.summary ? (
                              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                {session.session_id}
                              </div>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-base font-bold text-foreground">
                            {formatCost(session.cost)}
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {formatDate(session.timestamp)}
                          </span>
                          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {session.model}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatNumber(session.usage.total_tokens)} tokens
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 ? (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPage((prev) => Math.max(1, prev - 1))
                    }
                    disabled={sessionPage === 1}
                    className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
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
                    className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {t('usageDashboard.nextPage')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {tooltip.visible ? (
        <div
          className="tahoe-popover fixed z-50 rounded-[14px] px-3 py-2"
          style={{
            left: tooltip.x,
            top: tooltip.y - 80,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="text-xs font-medium text-foreground">
            {formatShortDate(tooltip.content.date)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('usageDashboard.tooltipCost', {
              cost: formatCost(tooltip.content.cost),
            })}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('usageDashboard.tooltipSessions', {
              count: tooltip.content.sessions,
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
