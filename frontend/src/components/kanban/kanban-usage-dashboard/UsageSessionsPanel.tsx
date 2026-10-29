import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { List } from 'lucide-react';
import type { ProjectUsageSessionSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { UsageCardHeader, UsageRankingMetricPill } from './UsageCards';
import {
  displayUsageLabel,
  formatOptionalCost,
  formatOptionalNumber,
} from './usageFormat';
import { preferredTokenTotal } from './usageModel';
import { SESSIONS_PER_PAGE } from './types';

export function UsageSessionsPanel({
  filteredSessions,
  paginatedSessions,
  totalPages,
  sessionPage,
  setSessionPage,
  sessionSortBy,
  setSessionSortBy,
  formatDate,
  resolveProjectName,
  notProvided,
}: {
  filteredSessions: ProjectUsageSessionSummary[];
  paginatedSessions: ProjectUsageSessionSummary[];
  totalPages: number;
  sessionPage: number;
  setSessionPage: Dispatch<SetStateAction<number>>;
  sessionSortBy: 'cost' | 'time';
  setSessionSortBy: Dispatch<SetStateAction<'cost' | 'time'>>;
  formatDate: (timestamp: number) => string;
  resolveProjectName: (
    folderPath: string | null | undefined,
    workspaceId: string
  ) => string;
  notProvided: string;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
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
            const rankIndex = (sessionPage - 1) * SESSIONS_PER_PAGE + index;
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
                          {displayUsageLabel(session.agent_id, notProvided)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <UsageRankingMetricPill
                    value={formatOptionalCost(session.cost, notProvided)}
                  />
                  <UsageRankingMetricPill
                    value={`${formatOptionalNumber(
                      preferredTokenTotal(session.tokens),
                      notProvided
                    )} ${t('usageDashboard.tokens')}`}
                  />
                  <UsageRankingMetricPill
                    value={displayUsageLabel(session.model, notProvided)}
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
            onClick={() => setSessionPage((prev) => Math.max(1, prev - 1))}
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
  );
}
