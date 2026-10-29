import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, FolderOpen, Hash, PieChart, Zap } from 'lucide-react';
import type { DimensionSubBreakdown, UsageHabitItem } from './types';
import {
  TokenCompositionList,
  UsageCardHeader,
  UsageHabitTile,
  UsageRankingCard,
} from './UsageCards';
import { formatOptionalCost, formatOptionalNumber } from './usageFormat';

export function DimensionDetailCard({
  breakdown,
  mode,
  notProvided,
}: {
  breakdown: DimensionSubBreakdown;
  mode: 'folder' | 'agent' | 'model';
  notProvided: string;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const compositionLabels = useMemo(
    () => ({
      input: t('usageDashboard.tokenInput'),
      output: t('usageDashboard.tokenOutput'),
      cacheWrite: t('usageDashboard.tokenCacheWrite'),
      cacheRead: t('usageDashboard.tokenCacheRead'),
    }),
    [t]
  );
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
}
