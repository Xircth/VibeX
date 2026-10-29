import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  FolderOpen,
  Hash,
  List,
  Package,
  RefreshCw,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { useProject } from '@/contexts/ProjectContext';
import { useAgentManagement } from '@/features/agent-management';
import { useProjects } from '@/hooks/useProjects';
import type { ProjectUsageDailyUsage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PlanUsageDashboard } from '../PlanUsageDashboard';
import {
  DATE_RANGE_OPTIONS,
  SESSIONS_PER_PAGE,
  type DateRange,
  type UsageTab,
} from './types';
import { extractFolderBasename } from './usageFormat';
import {
  getUsageStatisticsQueryOptions,
  normalizeUsageStatistics,
} from './usageStatistics';
import { preferredTokenTotal } from './usageModel';
import { UsageOverviewPanel } from './UsageOverviewPanel';
import { UsageDimensionPanels } from './UsageDimensionPanels';
import { UsageSessionsPanel } from './UsageSessionsPanel';

export function KanbanUsageDashboard() {
  const { t } = useTranslation(['tasks', 'common']);
  const { projectId } = useProject();
  const { projects } = useProjects();
  const { state: agentManagement } = useAgentManagement();
  const catalogAgents = agentManagement.agents;
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

  const failedProviders =
    statistics?.provider_status?.filter((provider) => !provider.success) ?? [];

  const tabs = useMemo(
    () => [
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
    ],
    [t]
  );

  const notProvided = t('usageDashboard.notProvided');

  return (
    <div className="kanban-usage-page flex h-full flex-col">
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
          <div
            className="kanban-usage-tab-rail flex flex-col gap-1 px-1 py-2"
            data-basic-guide="usage-nav"
          >
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                title={tab.label}
                aria-label={tab.label}
                data-basic-guide={`usage-nav-${tab.key}`}
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
            <UsageOverviewPanel
              statistics={statistics}
              catalogAgents={catalogAgents}
              filteredDailyUsage={filteredDailyUsage}
              maxDailyTokens={maxDailyTokens}
              notProvided={notProvided}
            />
          ) : null}

          {statistics &&
          (activeTab === 'folders' ||
            activeTab === 'agents' ||
            activeTab === 'models') ? (
            <UsageDimensionPanels
              activeTab={activeTab}
              statistics={statistics}
              expandedFolderId={expandedFolderId}
              setExpandedFolderId={setExpandedFolderId}
              expandedAgentId={expandedAgentId}
              setExpandedAgentId={setExpandedAgentId}
              expandedModelId={expandedModelId}
              setExpandedModelId={setExpandedModelId}
              resolveProjectName={resolveProjectName}
              notProvided={notProvided}
            />
          ) : null}

          {statistics && activeTab === 'sessions' ? (
            <UsageSessionsPanel
              filteredSessions={filteredSessions}
              paginatedSessions={paginatedSessions}
              totalPages={totalPages}
              sessionPage={sessionPage}
              setSessionPage={setSessionPage}
              sessionSortBy={sessionSortBy}
              setSessionSortBy={setSessionSortBy}
              formatDate={formatDate}
              resolveProjectName={resolveProjectName}
              notProvided={notProvided}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
