import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import {
  localUsageApi,
  type ProjectUsageStatistics,
  type ProjectUsageDailyUsage,
  type ProjectUsageSessionSummary,
} from '@/lib/api';
import { cn } from '@/lib/utils';

type UsageTab = 'overview' | 'models' | 'sessions';
type DateRange = '7d' | '30d' | 'all';

const SESSIONS_PER_PAGE = 15;

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
  if (Number.isNaN(date.getTime())) {
    return dateStr;
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function KanbanUsageDashboard() {
  const { projectId } = useProject();
  const { projects } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<UsageTab>('overview');
  const [dateRange, setDateRange] = useState<DateRange>('7d');
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSortBy, setSessionSortBy] = useState<'cost' | 'time'>('cost');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [statistics, setStatistics] = useState<ProjectUsageStatistics | null>(null);
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

  const loadStatistics = useCallback(async () => {
    const id = selectedProjectId === 'all' ? projectId : selectedProjectId;
    if (!id) return;

    setLoading(true);
    setError(null);
    try {
      const next = await localUsageApi.getProjectStatistics({
        projectId: id,
        dateRange,
      });
      setStatistics(next);
    } catch (loadError) {
      setStatistics(null);
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedProjectId, dateRange]);

  useEffect(() => {
    void loadStatistics();
  }, [loadStatistics]);

  useEffect(() => {
    setSessionPage(1);
  }, [dateRange]);

  const formatDate = useCallback((timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
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
      return (
        <span className="text-[10px] text-muted-foreground">→ 0%</span>
      );
    }
    const isUp = value > 0;
    return (
      <span
        className={cn(
          'text-[10px] font-medium',
          isUp ? 'text-red-500' : 'text-green-500'
        )}
      >
        {isUp ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%
      </span>
    );
  }, []);

  const filterByDateRange = useCallback(
    <T extends { timestamp?: number; date?: string }>(items: T[]) => {
      if (dateRange === 'all') return items;
      const now = Date.now();
      const cutoff =
        dateRange === '7d'
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;
      return items.filter((item) => {
        const time =
          item.timestamp ?? (item.date ? new Date(item.date).getTime() : 0);
        return time >= cutoff;
      });
    },
    [dateRange]
  );

  const filteredSessions = useMemo(() => {
    const source = filterByDateRange<ProjectUsageSessionSummary>(
      statistics?.sessions ?? []
    );
    return source.slice().sort((a, b) => {
      if (sessionSortBy === 'cost') {
        return b.cost - a.cost;
      }
      return b.timestamp - a.timestamp;
    });
  }, [filterByDateRange, sessionSortBy, statistics?.sessions]);

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

  const filteredDailyUsage = useMemo(
    () =>
      filterByDateRange<ProjectUsageDailyUsage>(statistics?.daily_usage ?? []),
    [filterByDateRange, statistics?.daily_usage]
  );

  const maxDailyCost = useMemo(
    () => Math.max(1, ...filteredDailyUsage.map((day) => day.cost)),
    [filteredDailyUsage]
  );

  const getTokenPercentage = useCallback(
    (value: number): number => {
      if (!statistics || statistics.total_usage.total_tokens === 0) return 0;
      return (value / statistics.total_usage.total_tokens) * 100;
    },
    [statistics]
  );

  const failedProviders =
    statistics?.provider_status?.filter((p) => !p.success) ?? [];

  const tabs = [
    { key: 'overview' as UsageTab, label: '概览', icon: TrendingUp, activeColor: 'bg-blue-500/20 text-blue-500' },
    { key: 'models' as UsageTab, label: '模型', icon: Hash, activeColor: 'bg-purple-500/20 text-purple-500' },
    { key: 'sessions' as UsageTab, label: '会话', icon: List, activeColor: 'bg-green-500/20 text-green-500' },
  ];

  const selectedProjectName = selectedProjectId === 'all'
    ? '所有项目'
    : projects.find(p => p.id === selectedProjectId)?.name ?? '当前项目';

  // Generate chart path for trend line
  const chartPath = useMemo(() => {
    if (filteredDailyUsage.length < 2) return '';
    const width = 100;
    const height = 100;
    const points = filteredDailyUsage.map((day, index) => {
      const x = (index / (filteredDailyUsage.length - 1)) * width;
      const y = height - (maxDailyCost > 0 ? (day.cost / maxDailyCost) * height : 0);
      return `${x},${y}`;
    });
    return `M ${points.join(' L ')}`;
  }, [filteredDailyUsage, maxDailyCost]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header with filters */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">计量统计</h2>
        </div>

        {/* Notice inline */}
        {noticeVisible && (
          <div className="flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600 dark:text-yellow-400">
            <span className="text-yellow-500 text-[10px]">⚠</span>
            <span>本地估算数据</span>
            <button
              type="button"
              onClick={() => setNoticeVisible(false)}
              className="ml-0.5 rounded p-0.5 hover:bg-yellow-500/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="flex-1" />

        {/* Project selector */}
        <div className="relative">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="h-7 appearance-none rounded-lg border border-border bg-background px-3 pr-7 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">所有项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>

        {/* Date range selector */}
        <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(['7d', '30d', 'all'] as DateRange[]).map((range) => (
            <button
              key={range}
              type="button"
              className={cn(
                'rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors',
                dateRange === range
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setDateRange(range)}
            >
              {range === '7d' ? '7天' : range === '30d' ? '30天' : '全部'}
            </button>
          ))}
        </div>

        {/* Refresh button */}
        <button
          type="button"
          onClick={() => void loadStatistics()}
          disabled={loading}
          className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Main content */}
      <div className="relative flex flex-1 min-h-0">
        {/* Floating vertical navigation - left center */}
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

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-4 pl-24">
          {/* Project info */}
          <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
            <FolderOpen className="h-4 w-4" />
            <span>{selectedProjectName}</span>
            {statistics?.last_updated ? (
              <>
                <span className="text-border">•</span>
                <span>最后更新: {formatRelativeTime(statistics.last_updated)}</span>
              </>
            ) : null}
          </div>

          {/* Failed providers warning */}
          {failedProviders.length > 0 && (
            <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-2.5 text-sm text-red-500">
              部分数据源扫描失败:{' '}
              {failedProviders.map((p) => p.provider).join(', ')}
            </div>
          )}

          {error ? (
            <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {loading && !statistics ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-base">加载中...</span>
            </div>
          ) : null}

          {!loading && !statistics && !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="mb-3 h-10 w-10 opacity-50" />
              <p className="text-base">暂无数据</p>
            </div>
          ) : null}

          {statistics ? (
            <>
              {/* Overview tab */}
              {activeTab === 'overview' ? (
                <div className="space-y-5">
                  {/* Stat cards with trend chart - 50/50 split */}
                  <div className="flex gap-4">
                    {/* Left: 4 stat cards in 2x2 grid - 50% width */}
                    <div className="flex-1 grid grid-cols-2 gap-4">
                      <div className="rounded-xl border border-border bg-gradient-to-br from-blue-500/10 to-transparent p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <CreditCard className="h-5 w-5 text-blue-500" />
                          <span className="text-sm text-muted-foreground">总费用</span>
                        </div>
                        <div className="text-2xl font-bold text-foreground">
                          {formatCost(statistics.estimated_cost)}
                        </div>
                        <div className="mt-1">{renderTrend(statistics.weekly_comparison.trends.cost)}</div>
                      </div>

                      <div className="rounded-xl border border-border bg-gradient-to-br from-green-500/10 to-transparent p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <MessageSquare className="h-5 w-5 text-green-500" />
                          <span className="text-sm text-muted-foreground">总会话</span>
                        </div>
                        <div className="text-2xl font-bold text-foreground">
                          {statistics.total_sessions}
                        </div>
                        <div className="mt-1">{renderTrend(statistics.weekly_comparison.trends.sessions)}</div>
                      </div>

                      <div className="rounded-xl border border-border bg-gradient-to-br from-purple-500/10 to-transparent p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <Hash className="h-5 w-5 text-purple-500" />
                          <span className="text-sm text-muted-foreground">总 Token</span>
                        </div>
                        <div className="text-2xl font-bold text-foreground">
                          {formatNumber(statistics.total_usage.total_tokens)}
                        </div>
                        <div className="mt-1">{renderTrend(statistics.weekly_comparison.trends.tokens)}</div>
                      </div>

                      <div className="rounded-xl border border-border bg-gradient-to-br from-orange-500/10 to-transparent p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <TrendingUp className="h-5 w-5 text-orange-500" />
                          <span className="text-sm text-muted-foreground">平均/会话</span>
                        </div>
                        <div className="text-2xl font-bold text-foreground">
                          {statistics.total_sessions > 0
                            ? formatCost(statistics.estimated_cost / statistics.total_sessions)
                            : '$0.0000'}
                        </div>
                      </div>
                    </div>

                    {/* Right: Trend chart - 50% width */}
                    {filteredDailyUsage.length > 0 && (
                      <div className="flex-1 rounded-xl border border-border bg-gradient-to-br from-muted/30 to-transparent p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <span className="text-sm font-medium text-muted-foreground">每日趋势</span>
                          <span className="text-xs text-muted-foreground">{filteredDailyUsage.length}天</span>
                        </div>
                        <div className="relative h-40">
                          {/* Y-axis labels */}
                          <div className="absolute inset-y-0 left-0 flex w-14 flex-col justify-between py-1">
                            {[1, 0.5, 0].map((ratio) => (
                              <span key={ratio} className="text-xs text-muted-foreground text-right pr-1">
                                {formatCost(maxDailyCost * ratio)}
                              </span>
                            ))}
                          </div>

                          {/* Chart area */}
                          <div className="absolute inset-y-0 left-12 right-0">
                            {/* Grid lines */}
                            <div className="absolute inset-0">
                              {[0, 50, 100].map((percent) => (
                                <div
                                  key={percent}
                                  className="absolute inset-x-0 border-t border-dashed border-border/30"
                                  style={{ bottom: `${percent}%` }}
                                />
                              ))}
                            </div>

                            {/* SVG chart */}
                            <svg
                              className="absolute inset-0 h-full w-full"
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                            >
                              <defs>
                                <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.2" />
                                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.02" />
                                </linearGradient>
                              </defs>

                              {/* Area fill */}
                              {chartPath && (
                                <path
                                  d={`${chartPath} L 100,100 L 0,100 Z`}
                                  fill="url(#areaGradient)"
                                />
                              )}

                              {/* Line */}
                              {chartPath && (
                                <path
                                  d={chartPath}
                                  fill="none"
                                  stroke="hsl(var(--primary))"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  vectorEffect="non-scaling-stroke"
                                />
                              )}

                              {/* Data points */}
                              {filteredDailyUsage.map((day, index) => {
                                const x = (index / Math.max(1, filteredDailyUsage.length - 1)) * 100;
                                const y = 100 - (maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0);
                                return (
                                  <circle
                                    key={day.date}
                                    cx={x}
                                    cy={y}
                                    r="2"
                                    fill="hsl(var(--primary))"
                                    className="cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
                                    onMouseEnter={(event) => {
                                      const rect = event.currentTarget.getBoundingClientRect();
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
                                      setTooltip((prev) => ({ ...prev, visible: false }))
                                    }
                                  />
                                );
                              })}
                            </svg>
                          </div>
                        </div>

                        {/* X-axis labels */}
                        <div className="ml-12 mt-1 flex justify-between">
                          {filteredDailyUsage.length > 0 && (
                            <>
                              <span className="text-[9px] text-muted-foreground">
                                {formatShortDate(filteredDailyUsage[0].date)}
                              </span>
                              {filteredDailyUsage.length > 2 && (
                                <span className="text-[9px] text-muted-foreground">
                                  {formatShortDate(filteredDailyUsage[Math.floor(filteredDailyUsage.length / 2)].date)}
                                </span>
                              )}
                              <span className="text-[9px] text-muted-foreground">
                                {formatShortDate(filteredDailyUsage[filteredDailyUsage.length - 1].date)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Token breakdown */}
                  <div className="rounded-xl border border-border p-5">
                    <h4 className="mb-4 text-base font-medium text-foreground">Token 分解</h4>
                    <div className="space-y-4">
                      {[
                        { label: '输入', value: statistics.total_usage.input_tokens, color: 'bg-blue-500' },
                        { label: '输出', value: statistics.total_usage.output_tokens, color: 'bg-green-500' },
                        { label: '缓存写入', value: statistics.total_usage.cache_write_tokens, color: 'bg-yellow-500' },
                        { label: '缓存读取', value: statistics.total_usage.cache_read_tokens, color: 'bg-purple-500' },
                      ].map((item) => (
                        <div key={item.label}>
                          <div className="mb-1.5 flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{item.label}</span>
                            <span className="font-medium text-foreground">{formatNumber(item.value)}</span>
                          </div>
                          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn('h-full rounded-full transition-all duration-500', item.color)}
                              style={{ width: `${getTokenPercentage(item.value)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Top models */}
                  {statistics.by_model.length > 0 && (
                    <div className="rounded-xl border border-border p-5">
                      <h4 className="mb-4 text-base font-medium text-foreground">热门模型</h4>
                      <div className="space-y-2.5">
                        {statistics.by_model.slice(0, 5).map((model, index) => (
                          <div key={model.model} className="flex items-center gap-3 rounded-lg bg-muted/30 p-3">
                            <span
                              className={cn(
                                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold',
                                index === 0 && 'bg-yellow-500/20 text-yellow-600',
                                index === 1 && 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
                                index === 2 && 'bg-orange-500/20 text-orange-600',
                                index >= 3 && 'bg-muted text-muted-foreground'
                              )}
                            >
                              {index + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">{model.model}</div>
                              <div className="text-xs text-muted-foreground">
                                {formatCost(model.total_cost)} • {formatNumber(model.total_tokens)} tokens
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {model.session_count} 会话
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Models tab */}
              {activeTab === 'models' ? (
                <div>
                  <h4 className="mb-4 text-sm font-medium text-foreground">按模型统计</h4>
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
                            {/* Model icon */}
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                              <Zap className="h-5 w-5 text-primary" />
                            </div>

                            {/* Model info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-foreground">{model.model}</span>
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                  {model.session_count} 会话
                                </span>
                              </div>
                              <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
                                <span>输入: {formatNumber(model.input_tokens)}</span>
                                <span>输出: {formatNumber(model.output_tokens)}</span>
                                <span>总 Token: {formatNumber(model.total_tokens)}</span>
                              </div>
                            </div>

                            {/* Cost */}
                            <div className="text-right">
                              <div className="text-lg font-bold text-foreground">{formatCost(model.total_cost)}</div>
                              <div className="text-[10px] text-muted-foreground">
                                平均 {formatCost(model.total_cost / Math.max(1, model.session_count))}/会话
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {/* Sessions tab */}
              {activeTab === 'sessions' ? (
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
                          {/* Rank badge */}
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground">
                            {(sessionPage - 1) * SESSIONS_PER_PAGE + index + 1}
                          </div>

                          {/* Session info */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-foreground truncate">
                                  {session.summary || session.session_id}
                                </div>
                                {session.summary && (
                                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {session.session_id}
                                  </div>
                                )}
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

                  {totalPages > 1 && (
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSessionPage((prev) => Math.max(1, prev - 1))}
                        disabled={sessionPage === 1}
                        className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        ← 上一页
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {sessionPage} / {totalPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSessionPage((prev) => Math.min(totalPages, prev + 1))}
                        disabled={sessionPage === totalPages}
                        className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        下一页 →
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip.visible && (
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
            费用: {formatCost(tooltip.content.cost)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {tooltip.content.sessions} 个会话
          </div>
        </div>
      )}
    </div>
  );
}
