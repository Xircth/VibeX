import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Hash, Zap } from 'lucide-react';
import type { ProjectUsageStatistics } from '@/lib/api';
import { cn } from '@/lib/utils';
import { UsageExpandableRow } from '../UsageExpandableRow';
import { UsageCardHeader, UsageRankingMetricPill } from './UsageCards';
import { DimensionDetailCard } from './DimensionDetailCard';
import { buildDimensionSubBreakdown } from './dimensionBreakdown';
import {
  displayUsageLabel,
  formatOptionalCost,
  formatOptionalNumber,
} from './usageFormat';
import { preferredTokenCounts, preferredTokenTotal } from './usageModel';
import type { UsageTab } from './types';

export function UsageDimensionPanels({
  activeTab,
  statistics,
  expandedFolderId,
  setExpandedFolderId,
  expandedAgentId,
  setExpandedAgentId,
  expandedModelId,
  setExpandedModelId,
  resolveProjectName,
  notProvided,
}: {
  activeTab: UsageTab;
  statistics: ProjectUsageStatistics;
  expandedFolderId: string | null;
  setExpandedFolderId: Dispatch<SetStateAction<string | null>>;
  expandedAgentId: string | null;
  setExpandedAgentId: Dispatch<SetStateAction<string | null>>;
  expandedModelId: string | null;
  setExpandedModelId: Dispatch<SetStateAction<string | null>>;
  resolveProjectName: (
    folderPath: string | null | undefined,
    workspaceId: string
  ) => string;
  notProvided: string;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
    <>
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
                  <UsageExpandableRow
                    key={folder.workspace_id}
                    expanded={isExpanded}
                    onToggle={() =>
                      setExpandedFolderId((prev) =>
                        prev === folder.workspace_id
                          ? null
                          : folder.workspace_id
                      )
                    }
                    detail={
                      folderBreakdown ? (
                        <DimensionDetailCard
                          breakdown={folderBreakdown}
                          mode="folder"
                          notProvided={notProvided}
                        />
                      ) : null
                    }
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
                        value={formatOptionalCost(folder.cost, notProvided)}
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
                    </div>
                  </UsageExpandableRow>
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
                  <UsageExpandableRow
                    key={agent.agent_id}
                    expanded={isExpanded}
                    onToggle={() =>
                      setExpandedAgentId((prev) =>
                        prev === agent.agent_id ? null : agent.agent_id
                      )
                    }
                    detail={
                      agentBreakdown ? (
                        <DimensionDetailCard
                          breakdown={agentBreakdown}
                          mode="agent"
                          notProvided={notProvided}
                        />
                      ) : null
                    }
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
                        value={formatOptionalCost(agent.cost, notProvided)}
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
                    </div>
                  </UsageExpandableRow>
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
                  (session) => (session.model ?? 'unprovided') === model.model
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
                  <UsageExpandableRow
                    key={model.model}
                    expanded={isExpanded}
                    onToggle={() =>
                      setExpandedModelId((prev) =>
                        prev === model.model ? null : model.model
                      )
                    }
                    detail={
                      modelBreakdown ? (
                        <DimensionDetailCard
                          breakdown={modelBreakdown}
                          mode="model"
                          notProvided={notProvided}
                        />
                      ) : null
                    }
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
                        value={formatOptionalCost(model.cost, notProvided)}
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
                    </div>
                  </UsageExpandableRow>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
