import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type ProjectUsageSessionSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

import { HEATMAP_OPACITIES, type HeatmapHover } from './types';
import { formatNumber } from './usageFormat';
import { preferredTokenTotal } from './usageModel';

export function UsageHeatmap({
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
      className="relative flex min-h-0 flex-1 flex-col justify-between gap-2"
    >
      <div
        className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1"
        style={{ gridTemplateRows: 'auto repeat(7, auto)' }}
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
              className="grid items-center gap-1"
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
                      'aspect-[4/3] w-full rounded-[3px]',
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
        <span className="aspect-[4/3] w-3 rounded-[2px] bg-muted/40 ring-1 ring-inset ring-border/50" />
        {HEATMAP_OPACITIES.map((opacity) => (
          <span
            key={opacity}
            className="aspect-[4/3] w-3 rounded-[2px]"
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
            className="pointer-events-none absolute rounded-[3px] ring-2 ring-foreground/35"
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
