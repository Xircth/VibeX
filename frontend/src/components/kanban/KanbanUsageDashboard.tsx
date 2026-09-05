import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Hash,
  TrendingUp,
  BarChart3,
  List,
  FolderOpen,
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
  type ProjectUsageSessionSummary,
  type ProjectUsageSourcedTokens,
  type ProjectUsageStatistics,
  type ProjectUsageTokenCounts,
} from '@/lib/api';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { cn } from '@/lib/utils';
import { PlanUsageDashboard } from './PlanUsageDashboard';

type UsageTab = 'overview' | 'folders' | 'agents' | 'models' | 'sessions' | 'plan';
type DateRange = '7d' | '30d' | 'all';

const SESSIONS_PER_PAGE = 15;
const DATE_RANGE_OPTIONS: DateRange[] = ['7d', '30d', 'all'];
const USAGE_STATS_STALE_TIME_MS = 2 * 60_000;
const USAGE_STATS_GC_TIME_MS = 10 * 60_000;
export const UNATTRIBUTED_VENDOR_NOTICE_MS = 10_000;
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

function OverviewStat({
  label,
  value,
  detail,
  compact = false,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong
        className={cn(
          'kanban-usage-stat__value mt-1 block font-semibold tabular-nums text-foreground',
          compact && 'kanban-usage-stat__value--compact'
        )}
      >
        {value}
      </strong>
      <div className="mt-1">{detail}</div>
    </div>
  );
}

function UsageSummaryPrimary({
  token,
  cache,
}: {
  token: ReactNode;
  cache: ReactNode;
}) {
  return (
    <div className="kanban-usage-card kanban-usage-summary__primary overflow-hidden p-4">
      <div className="min-w-0">{token}</div>
      {cache}
    </div>
  );
}

function UsageSummaryMetrics({ children }: { children: ReactNode }) {
  return (
    <div className="kanban-usage-card kanban-usage-summary__metrics overflow-hidden p-3">
      {children}
    </div>
  );
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

function preferredTokenCounts(
  tokens: ProjectUsageSourcedTokens
): ProjectUsageTokenCounts | null {
  return tokens.protocol ?? tokens.vendor_log ?? null;
}

function preferredTokenTotal(
  tokens: ProjectUsageSourcedTokens
): number | null {
  return preferredTokenCounts(tokens)?.total_tokens ?? null;
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
      className="relative flex min-h-0 flex-1 flex-col gap-2"
    >
      <div
        className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-0.5"
        style={{ gridTemplateRows: 'auto repeat(7, minmax(1rem, 1fr))' }}
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
              className="grid h-full min-h-4 gap-0.5"
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
                      'h-full w-full rounded-full',
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
        <span className="size-2.5 rounded-full bg-muted/40 ring-1 ring-inset ring-border/50" />
        {HEATMAP_OPACITIES.map((opacity) => (
          <span
            key={opacity}
            className="size-2.5 rounded-full"
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
            className="pointer-events-none absolute rounded-full ring-2 ring-foreground/35"
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
  const [dismissedUnattributedCount, setDismissedUnattributedCount] = useState<
    number | null
  >(null);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: {
      date: string;
      cost: number;
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
      cost: 0,
      sessions: 0,
      totalTokens: 0,
      freshTokens: 0,
      cacheReadTokens: 0,
    },
  });
  const availableTargets = useMemo(
    () => (projectId ? [preferredProjectTarget, 'global'] : ['global']),
    [preferredProjectTarget, projectId]
  );
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

  const statistics = statisticsQuery.data ?? null;
  const unattributedCount = statistics?.unattributed_vendor_sessions ?? 0;
  const unattributedNoticeVisible =
    activeTab !== 'plan' &&
    unattributedCount > 0 &&
    dismissedUnattributedCount !== unattributedCount;
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

  useEffect(() => {
    if (!unattributedNoticeVisible) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDismissedUnattributedCount(unattributedCount);
    }, UNATTRIBUTED_VENDOR_NOTICE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [unattributedCount, unattributedNoticeVisible]);

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
        ...filteredDailyUsage.map(
          (day) => preferredTokenTotal(day.tokens) ?? 0
        )
      ),
    [filteredDailyUsage]
  );

  const getTokenPercentage = useCallback(
    (value: number | null | undefined): number => {
      const total = preferredTokenTotal(statistics?.total_tokens ?? { sources_disagree: false });
      if (total == null || total === 0 || value == null) return 0;
      return (value / total) * 100;
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

  const selectedProjectName =
    selectedTarget === 'global'
      ? t('usageDashboard.global')
      : (projects.find((project) => `project:${project.id}` === selectedTarget)
          ?.name ?? t('usageDashboard.currentProject'));

  const topModels = statistics?.by_model.slice(0, 5) ?? [];
  const notProvided = t('usageDashboard.notProvided');
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
              aria-label={t('common:close')}
              title={t('common:close')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}

        <div className="flex-1" />

        {activeTab !== 'plan' ? (
          <>
            <AstryxSelect
              value={selectedTarget}
              options={targetOptions}
              onChange={(nextTarget) => {
                startTransition(() => {
                  setSelectedTarget(nextTarget);
                });
              }}
              ariaLabel={t('usageDashboard.currentProject')}
              className="w-56 shrink-0"
            />

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
              aria-label={t('usageDashboard.refresh')}
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

          {unattributedNoticeVisible ? (
            <div className="kanban-usage-message-warning mb-4 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                {t('usageDashboard.unattributedVendor', {
                  count: unattributedCount,
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  setDismissedUnattributedCount(unattributedCount)
                }
                className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--surface-control-hover)]"
                aria-label={t('common:close')}
                title={t('common:close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
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

          {activeTab === 'plan' ? <PlanUsageDashboard /> : null}

          {statistics && activeTab === 'overview' ? (
            <div className="space-y-4">
              <section
                aria-label={t('usageDashboard.summaryRegion')}
                className="kanban-usage-summary"
              >
                <UsageSummaryPrimary
                  token={
                    <OverviewStat
                      label={t('usageDashboard.totalTokens')}
                      value={formatOptionalNumber(
                        preferredTokenTotal(statistics.total_tokens),
                        notProvided
                      )}
                      detail={
                        statistics.total_tokens.sources_disagree ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('usageDashboard.sourcesDisagree', {
                              protocol: formatOptionalNumber(
                                statistics.total_tokens.protocol?.total_tokens,
                                notProvided
                              ),
                              vendor: formatOptionalNumber(
                                statistics.total_tokens.vendor_log
                                  ?.total_tokens,
                                notProvided
                              ),
                            })}
                          </span>
                        ) : preferredTokenTotal(statistics.total_tokens) ==
                          null ? (
                          <span className="text-[11px] text-muted-foreground">
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
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">
                          {t('usageDashboard.cacheHitRate')}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatOptionalNumber(
                            displayTokens?.cache_read_tokens,
                            notProvided
                          )}{' '}
                          {t('usageDashboard.tokenCacheRead')}
                        </div>
                      </div>
                    </div>
                  }
                />
                <UsageSummaryMetrics>
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
                    value={
                      filteredDailyUsage.filter(
                        (day) => (preferredTokenTotal(day.tokens) ?? 0) > 0
                      ).length
                    }
                    detail={
                      <span className="text-[11px] text-muted-foreground">
                        {t('usageDashboard.daysCount', {
                          count: filteredDailyUsage.length,
                        })}
                      </span>
                    }
                  />
                </UsageSummaryMetrics>
              </section>

              {filteredDailyUsage.length > 0 ? (
                <div className="kanban-usage-card min-w-0 p-4">
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                      <BarChart3
                        className="size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {t('usageDashboard.dailyTrend')}
                    </h4>
                    <span className="text-xs text-muted-foreground">
                      {t('usageDashboard.daysCount', {
                        count: filteredDailyUsage.length,
                      })}
                    </span>
                  </div>

                  <div className="flex items-center justify-end gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-foreground/75" />
                      {t('usageDashboard.freshTokens')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                      {t('usageDashboard.tokenCacheRead')}
                    </span>
                  </div>

                  <div className="mt-3 flex h-44 min-w-0">
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
                          minWidth: `${Math.max(360, filteredDailyUsage.length * 16)}px`,
                        }}
                      >
                        {filteredDailyUsage.map((day) => {
                          const totalTokens = preferredTokenTotal(day.tokens) ?? 0;
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
                          const showTooltip = (element: HTMLButtonElement) => {
                            const rect = element.getBoundingClientRect();
                            setTooltip({
                              visible: true,
                              x: rect.left + rect.width / 2,
                              y: rect.top,
                              content: {
                                date: day.date,
                                cost: day.cost ?? 0,
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
                                className="flex w-full min-w-[6px] flex-col-reverse overflow-hidden rounded-t-[3px] ring-primary transition-[filter,box-shadow] duration-200 group-hover:brightness-110 group-focus-visible:ring-2 motion-reduce:transition-none"
                                style={{
                                  height: `${Math.max(totalTokens > 0 ? 2 : 0, totalHeight)}%`,
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
                          filteredDailyUsage[filteredDailyUsage.length - 1].date
                        )}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="grid items-stretch gap-4 lg:grid-cols-2">
                <section className="kanban-usage-card flex min-w-0 flex-col p-4">
                  <header className="mb-3 shrink-0">
                    <h4 className="text-[13px] font-semibold text-foreground">
                      {t('usageDashboard.tokenComposition')}
                    </h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t('usageDashboard.tokenCompositionHint')}
                    </p>
                  </header>
                  <div className="flex flex-1 flex-col justify-between gap-3">
                    {[
                      {
                        id: 'input',
                        label: t('usageDashboard.tokenInput'),
                        value: displayTokens?.input_tokens ?? null,
                        color: 'bg-foreground',
                      },
                      {
                        id: 'output',
                        label: t('usageDashboard.tokenOutput'),
                        value: displayTokens?.output_tokens ?? null,
                        color: 'bg-foreground/70',
                      },
                      {
                        id: 'cacheWrite',
                        label: t('usageDashboard.tokenCacheWrite'),
                        value: displayTokens?.cache_write_tokens ?? null,
                        color: 'bg-foreground/45',
                      },
                      {
                        id: 'cacheRead',
                        label: t('usageDashboard.tokenCacheRead'),
                        value: displayTokens?.cache_read_tokens ?? null,
                        color: 'bg-primary',
                      },
                    ].map((item) => {
                      const percentage = getTokenPercentage(item.value);
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
                </section>

                <section className="kanban-usage-card flex min-w-0 flex-col p-4">
                  <header className="mb-3 shrink-0">
                    <h4 className="text-[13px] font-semibold text-foreground">
                      {t('usageDashboard.activityHeatmap')}
                    </h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t('usageDashboard.heatmapHint')}
                    </p>
                  </header>
                  <UsageHeatmap sessions={statistics.sessions} />
                </section>
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
                            {formatOptionalCost(model.cost, notProvided)} ·{' '}
                            {formatOptionalNumber(
                              preferredTokenTotal(model.tokens),
                              notProvided
                            )}{' '}
                            {t('usageDashboard.tokens')}
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

          {statistics && activeTab === 'folders' ? (
            <div>
              <h4 className="mb-4 text-sm font-medium text-foreground">
                {t('usageDashboard.byFolderTitle')}
              </h4>
              {statistics.by_folder.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <FolderOpen className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noFolderData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_folder.map((folder) => (
                    <div
                      key={folder.workspace_id}
                      className="kanban-usage-card p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">
                            {folder.folder || folder.workspace_id}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t('usageDashboard.sessionsCount', {
                              count: folder.session_count,
                            })}
                          </div>
                        </div>
                        <div className="text-right text-sm tabular-nums">
                          {formatOptionalNumber(
                            preferredTokenTotal(folder.tokens),
                            notProvided
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {statistics && activeTab === 'agents' ? (
            <div>
              <h4 className="mb-4 text-sm font-medium text-foreground">
                {t('usageDashboard.byAgentTitle')}
              </h4>
              {statistics.by_agent.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Zap className="mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">{t('usageDashboard.noAgentData')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {statistics.by_agent.map((agent) => (
                    <div key={agent.agent_id} className="kanban-usage-card p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">
                            {agent.agent_id === 'unprovided'
                              ? notProvided
                              : agent.agent_id}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t('usageDashboard.sessionsCount', {
                              count: agent.session_count,
                            })}
                            {preferredTokenCounts(agent.tokens) == null
                              ? ` · ${t('usageDashboard.notProvidedReason')}`
                              : null}
                          </div>
                        </div>
                        <div className="text-right text-sm tabular-nums">
                          {formatOptionalNumber(
                            preferredTokenTotal(agent.tokens),
                            notProvided
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                                value: formatOptionalNumber(
                                  preferredTokenCounts(model.tokens)
                                    ?.input_tokens,
                                  notProvided
                                ),
                              })}
                            </span>
                            <span>
                              {t('usageDashboard.modelOutput', {
                                value: formatOptionalNumber(
                                  preferredTokenCounts(model.tokens)
                                    ?.output_tokens,
                                  notProvided
                                ),
                              })}
                            </span>
                            <span>
                              {t('usageDashboard.modelTotalTokens', {
                                value: formatOptionalNumber(
                                  preferredTokenTotal(model.tokens),
                                  notProvided
                                ),
                              })}
                            </span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-lg font-bold text-foreground">
                            {formatOptionalCost(model.cost, notProvided)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {t('usageDashboard.avgCostPerSession', {
                              cost: formatOptionalCost(
                                model.cost != null
                                  ? model.cost /
                                      Math.max(1, model.session_count)
                                  : null,
                                notProvided
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
                            {formatOptionalCost(session.cost, notProvided)}
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {formatDate(session.timestamp)}
                          </span>
                          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {session.model ?? notProvided}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatOptionalNumber(
                              preferredTokenTotal(session.tokens),
                              notProvided
                            )}{' '}
                            {t('usageDashboard.tokens')}
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
            </div>
          ) : null}
        </div>
      </div>

      {tooltip.visible ? (
        <div
          className="tahoe-popover fixed z-50 rounded-lg px-3 py-2"
          style={{
            left: tooltip.x,
            top: tooltip.y - 80,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="text-xs font-medium text-foreground">
            {formatShortDate(tooltip.content.date)}
          </div>
          <div className="mt-1 text-[10px] font-medium text-foreground">
            {t('usageDashboard.tooltipTotalTokens', {
              value: formatNumber(tooltip.content.totalTokens),
            })}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('usageDashboard.tooltipFreshTokens', {
              value: formatNumber(tooltip.content.freshTokens),
            })}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('usageDashboard.tooltipCacheReadTokens', {
              value: formatNumber(tooltip.content.cacheReadTokens),
            })}
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
