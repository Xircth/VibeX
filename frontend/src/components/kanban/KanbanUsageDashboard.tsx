import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { CodexPlanDashboard } from '@/components/kanban/CodexPlanDashboard';

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

  const formatDate = useCallback((timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    });
  }, []);

  const formatRelativeTime = useCallback(
    (timestamp: number): string => {
      const now = Date.now();
      const diffMs = now - timestamp;
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) return '刚刚';
      if (diffMin < 60) return `${diffMin}分钟前`;
      if (diffHour < 24) return `${diffHour}小时前`;

      return formatDate(timestamp);
    },
    [formatDate]
  );

  const renderTrend = useCallback((value: number) => {
    if (value === 0) {
      return <span className="text-[10px] text-muted-foreground">持平 0%</span>;
    }

    const isUp = value > 0;
    return (
      <span
        className={cn(
          'text-[10px] font-medium',
          isUp ? 'text-red-500' : 'text-green-500'
        )}
      >
        {isUp ? '上涨' : '下降'} {Math.abs(value).toFixed(1)}%
      </span>
    );
  }, []);

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
      label: '概览',
      icon: TrendingUp,
      activeColor: 'bg-blue-500/20 text-blue-500',
    },
    {
      key: 'models' as UsageTab,
      label: '模型',
      icon: Hash,
      activeColor: 'bg-purple-500/20 text-purple-500',
    },
    {
      key: 'sessions' as UsageTab,
      label: '会话',
      icon: List,
      activeColor: 'bg-green-500/20 text-green-500',
    },
    {
      key: 'plan' as UsageTab,
      label: '套餐',
      icon: Package,
      activeColor: 'bg-orange-500/20 text-orange-500',
    },
  ];

  const selectedProjectName =
    selectedTarget === 'global'
      ? '全局'
      : (projects.find((project) => `project:${project.id}` === selectedTarget)
          ?.name ?? '当前项目');

  const topModels = statistics?.by_model.slice(0, 5) ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">计量统计</h2>
        </div>

        {noticeVisible && activeTab !== 'plan' ? (
          <div className="flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600 dark:text-yellow-400">
            <span className="text-[10px] text-yellow-500">提示</span>
            <span>
              {statistics?.pricing_notice ??
                '按官方定价估算，Claude 缓存写入默认按 5 分钟档处理'}
            </span>
            <button
              type="button"
              onClick={() => setNoticeVisible(false)}
              className="ml-0.5 rounded p-0.5 hover:bg-yellow-500/20"
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
                <option value="global">全局</option>
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
                  {range === '7d' ? '7天' : range === '30d' ? '30天' : '全部'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void statisticsQuery.refetch()}
              disabled={statisticsQuery.isFetching}
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="刷新"
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
          <div className="flex flex-col gap-1 rounded-2xl border-2 border-border bg-background/80 px-1 py-2 shadow-lg backdrop-blur-xl">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                title={tab.label}
                className={cn(
                  'flex items-center justify-center rounded-xl px-2 py-3 transition-all',
                  activeTab === tab.key
                    ? cn(tab.activeColor, 'backdrop-blur-sm')
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                )}
                onClick={() => setActiveTab(tab.key)}
              >
                <tab.icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 pl-24">
          {activeTab === 'plan' ? <CodexPlanDashboard /> : null}

          {activeTab !== 'plan' ? (
            <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              <span>{selectedProjectName}</span>
              {statistics?.last_updated ? (
                <>
                  <span className="text-border">•</span>
                  <span>
                    最后更新：{formatRelativeTime(statistics.last_updated)}
                  </span>
                </>
              ) : null}
              {statisticsQuery.isFetching && statistics ? (
                <>
                  <span className="text-border">•</span>
                  <span className="flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    更新中
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          {activeTab !== 'plan' && failedProviders.length > 0 ? (
            <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-2.5 text-sm text-red-500">
              部分数据源扫描失败：
              {failedProviders.map((p) => p.provider).join(', ')}
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
              <span className="text-base">加载中...</span>
            </div>
          ) : null}

          {activeTab !== 'plan' && !loading && !statistics && !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="mb-3 h-10 w-10 opacity-50" />
              <p className="text-base">暂无数据</p>
            </div>
          ) : null}

          {statistics && activeTab === 'overview' ? (
            <div className="space-y-5">
              <div className="flex gap-4">
                <div className="grid flex-1 grid-cols-2 gap-4">
                  <div className="rounded-xl border border-border bg-gradient-to-br from-blue-500/10 to-transparent p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-blue-500" />
                      <span className="text-sm text-muted-foreground">
                        总费用
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {formatCost(statistics.estimated_cost)}
                    </div>
                    <div className="mt-1">
                      {renderTrend(statistics.weekly_comparison.trends.cost)}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-gradient-to-br from-green-500/10 to-transparent p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <MessageSquare className="h-5 w-5 text-green-500" />
                      <span className="text-sm text-muted-foreground">
                        总会话
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

                  <div className="rounded-xl border border-border bg-gradient-to-br from-purple-500/10 to-transparent p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Hash className="h-5 w-5 text-purple-500" />
                      <span className="text-sm text-muted-foreground">
                        总 Token
                      </span>
                    </div>
                    <div className="text-2xl font-bold text-foreground">
                      {formatNumber(statistics.total_usage.total_tokens)}
                    </div>
                    <div className="mt-1">
                      {renderTrend(statistics.weekly_comparison.trends.tokens)}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-gradient-to-br from-orange-500/10 to-transparent p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <TrendingUp className="h-5 w-5 text-orange-500" />
                      <span className="text-sm text-muted-foreground">
                        平均/会话
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
                  <div className="flex-1 rounded-xl border border-border bg-gradient-to-br from-muted/30 to-transparent p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-sm font-medium text-muted-foreground">
                        每日趋势
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {filteredDailyUsage.length}天
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
                              <stop
                                offset="0%"
                                stopColor="hsl(var(--primary))"
                                stopOpacity="0.2"
                              />
                              <stop
                                offset="100%"
                                stopColor="hsl(var(--primary))"
                                stopOpacity="0.02"
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
                              stroke="hsl(var(--primary))"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          ) : null}

                          {filteredDailyUsage.map((day, index) => {
                            const x =
                              (index /
                                Math.max(1, filteredDailyUsage.length - 1)) *
                              100;
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
                                fill="hsl(var(--primary))"
                                className="cursor-pointer opacity-0 transition-opacity hover:opacity-100"
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

                    <div className="ml-12 mt-1 flex justify-between">
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
                      <span className="text-[9px] text-muted-foreground">
                        {formatShortDate(
                          filteredDailyUsage[filteredDailyUsage.length - 1].date
                        )}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-border p-5">
                <h4 className="mb-4 text-base font-medium text-foreground">
                  Token 构成
                </h4>
                <div className="space-y-4">
                  {[
                    {
                      label: '输入',
                      value: statistics.total_usage.input_tokens,
                      color: 'bg-blue-500',
                    },
                    {
                      label: '输出',
                      value: statistics.total_usage.output_tokens,
                      color: 'bg-green-500',
                    },
                    {
                      label: '缓存写入',
                      value: statistics.total_usage.cache_write_tokens,
                      color: 'bg-yellow-500',
                    },
                    {
                      label: '缓存读取',
                      value: statistics.total_usage.cache_read_tokens,
                      color: 'bg-purple-500',
                    },
                  ].map((item) => (
                    <div key={item.label}>
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
                            'h-full rounded-full transition-all duration-500',
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
                <div className="rounded-xl border border-border p-5">
                  <h4 className="mb-4 text-base font-medium text-foreground">
                    热门模型
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
                            index === 0 && 'bg-yellow-500/20 text-yellow-600',
                            index === 1 &&
                              'bg-muted text-muted-foreground',
                            index === 2 && 'bg-orange-500/20 text-orange-600',
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
                          {model.session_count} 会话
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
                按模型统计
              </h4>
              {statistics.by_model.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Hash className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">暂无模型数据</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_model.map((model) => (
                    <div
                      key={model.model}
                      className="group rounded-xl border border-border bg-gradient-to-r from-background to-muted/20 p-4 transition-all hover:shadow-md"
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
                              {model.session_count} 会话
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
                            <span>
                              输入：{formatNumber(model.input_tokens)}
                            </span>
                            <span>
                              输出：{formatNumber(model.output_tokens)}
                            </span>
                            <span>
                              总 Token：{formatNumber(model.total_tokens)}
                            </span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-lg font-bold text-foreground">
                            {formatCost(model.total_cost)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            平均{' '}
                            {formatCost(
                              model.total_cost /
                                Math.max(1, model.session_count)
                            )}
                            /会话
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
                  会话列表 ({filteredSessions.length})
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
                    按费用
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
                    按时间
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {paginatedSessions.map((session, index) => (
                  <div
                    key={session.session_id}
                    className="group rounded-xl border border-border bg-gradient-to-r from-background to-muted/20 p-4 transition-all hover:shadow-md"
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
                    上一页
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
                    下一页
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {tooltip.visible ? (
        <div
          className="fixed z-50 rounded-xl border border-border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur-sm"
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
            费用：{formatCost(tooltip.content.cost)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {tooltip.content.sessions} 个会话
          </div>
        </div>
      ) : null}
    </div>
  );
}
