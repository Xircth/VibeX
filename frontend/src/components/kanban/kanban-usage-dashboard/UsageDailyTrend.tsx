import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import type { ProjectUsageDailyUsage } from '@/lib/api';
import { UsageCardHeader } from './UsageCards';
import {
  formatNumber,
  formatOptionalNumber,
  formatShortDate,
  formatTrendTooltipDate,
} from './usageFormat';
import { preferredTokenCounts, preferredTokenTotal } from './usageModel';

export function UsageDailyTrend({
  filteredDailyUsage,
  maxDailyTokens,
  notProvided,
  weekdayLabels,
}: {
  filteredDailyUsage: ProjectUsageDailyUsage[];
  maxDailyTokens: number;
  notProvided: string;
  weekdayLabels: string[];
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const [tooltip, setTooltip] = useState({
    visible: false,
    x: 0,
    y: 0,
    content: {
      date: '',
      sessions: 0,
      turns: null as number | null,
      totalTokens: 0,
      freshTokens: 0,
      cacheReadTokens: 0,
    },
  });
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

  return (
    <>
      <section className="kanban-usage-card kanban-usage-trend-row__trend flex min-w-0 flex-col p-4">
        <UsageCardHeader
          icon={BarChart3}
          title={t('usageDashboard.dailyTrend')}
          right={
            <div className="flex flex-wrap items-center justify-end gap-4 text-xs text-muted-foreground">
              {filteredDailyUsage.length > 0 ? (
                <div className="flex flex-wrap items-center gap-4 text-xs">
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
                      <span className="h-0.5 w-full rounded-full bg-[var(--usage-blue-fg)]" />
                      <span className="absolute h-2 w-2 rounded-full border border-background bg-[var(--usage-blue-fg)]" />
                    </span>
                    {t('usageDashboard.trendLine')}
                  </span>
                </div>
              ) : null}
              <span>
                {t('usageDashboard.daysCount', {
                  count: filteredDailyUsage.length,
                })}
              </span>
            </div>
          }
        />

        {filteredDailyUsage.length > 0 ? (
          <>
            <div className="mt-1 flex h-44 min-w-0 flex-1">
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
                      stroke="var(--usage-blue-fg)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      points={trendPolylinePointsAttr}
                    />
                  </svg>

                  {filteredDailyUsage.map((day) => {
                    const totalTokens = preferredTokenTotal(day.tokens) ?? 0;
                    const cacheReadTokens = Math.min(
                      totalTokens,
                      Math.max(
                        0,
                        preferredTokenCounts(day.tokens)?.cache_read_tokens ?? 0
                      )
                    );
                    const freshTokens = Math.max(
                      0,
                      totalTokens - cacheReadTokens
                    );
                    const totalHeight = (totalTokens / maxDailyTokens) * 100;
                    const barHeightPct = Math.max(
                      totalTokens > 0 ? 2 : 0,
                      totalHeight
                    );
                    const showTooltip = (element: HTMLButtonElement) => {
                      const rect = element.getBoundingClientRect();
                      setTooltip({
                        visible: true,
                        x: rect.left + rect.width / 2,
                        y: rect.top,
                        content: {
                          date: day.date,
                          sessions: day.sessions,
                          turns: day.turns ?? null,
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
                        onFocus={(event) => showTooltip(event.currentTarget)}
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
                          className="pointer-events-none absolute left-1/2 z-20 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full border border-background bg-[var(--usage-blue-fg)] shadow-xs transition-transform duration-150 group-hover:scale-125"
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
              <span className="text-[10px] text-muted-foreground">
                {formatShortDate(filteredDailyUsage[0].date)}
              </span>
              {filteredDailyUsage.length > 2 ? (
                <span className="text-[10px] text-muted-foreground">
                  {formatShortDate(
                    filteredDailyUsage[
                      Math.floor(filteredDailyUsage.length / 2)
                    ].date
                  )}
                </span>
              ) : null}
              {filteredDailyUsage.length > 1 ? (
                <span className="text-[10px] text-muted-foreground">
                  {formatShortDate(
                    filteredDailyUsage[filteredDailyUsage.length - 1].date
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
      {tooltip.visible
        ? createPortal(
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
                  {formatTrendTooltipDate(
                    tooltip.content.date,
                    weekdayLabels,
                    t
                  )}
                </span>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {formatNumber(tooltip.content.totalTokens)}
                </span>
              </div>

              <div className="mt-2 space-y-1 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-foreground" />
                    {t('usageDashboard.tokenCacheRead')}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatNumber(tooltip.content.cacheReadTokens)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-foreground/35" />
                    {t('usageDashboard.freshTokens')}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatNumber(tooltip.content.freshTokens)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t('usageDashboard.turnsLabel')}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatOptionalNumber(tooltip.content.turns, notProvided)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t('usageDashboard.sessionsLabel')}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {tooltip.content.sessions}
                  </span>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
