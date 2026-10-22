import { useTranslation } from 'react-i18next';
import {
  Bot,
  GitFork,
  Terminal,
  User,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  formatDurationMs,
  spanWindow,
  type ActivityChart,
  type ActivitySpan,
  type ActivitySpanKind,
} from './workspaceActivityModel';

const KIND_BAR_CLASS: Record<ActivitySpanKind, string> = {
  user: 'border border-primary/70 bg-primary/25',
  assistant:
    'border border-[hsl(var(--success)/0.75)] bg-[hsl(var(--success)/0.28)]',
  tool: 'border border-[hsl(var(--warning)/0.8)] bg-[hsl(var(--warning)/0.28)]',
  delegation:
    'border border-[hsl(var(--primary)/0.8)] bg-[hsl(var(--primary)/0.28)]',
  output: 'border border-muted-foreground/50 bg-muted-foreground/20',
};

const KIND_ICON_CLASS: Record<ActivitySpanKind, string> = {
  user: 'text-primary',
  assistant: 'text-[hsl(var(--success))]',
  tool: 'text-[hsl(var(--warning))]',
  delegation: 'text-primary',
  output: 'text-muted-foreground',
};

const KIND_ICON: Record<ActivitySpanKind, LucideIcon> = {
  user: User,
  assistant: Bot,
  tool: Wrench,
  delegation: GitFork,
  output: Terminal,
};

function GanttRow({
  span,
  windowStart,
  windowDuration,
  untimedLabel,
}: {
  span: ActivitySpan;
  windowStart: number;
  windowDuration: number;
  untimedLabel: string;
}) {
  const Icon = KIND_ICON[span.kind];
  const rawLeft = span.timed
    ? ((span.startMs - windowStart) / windowDuration) * 100
    : 0;
  const left = Math.min(Math.max(rawLeft, 0), 98);
  const rawWidth = span.timed ? (span.durationMs / windowDuration) * 100 : 0;
  const width = span.timed ? Math.min(Math.max(rawWidth, 1.5), 100 - left) : 0;

  return (
    <div className="grid grid-cols-[minmax(7rem,42%)_minmax(0,1fr)_3.75rem] items-center gap-2 rounded-[calc(var(--radius)-6px)] px-1.5 py-1 transition-colors hover:bg-[var(--surface-control-hover)]">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn('h-3.5 w-3.5 shrink-0', KIND_ICON_CLASS[span.kind])}
          aria-hidden="true"
        />
        <span
          className="truncate text-xs leading-4 text-foreground"
          title={span.label}
        >
          {span.label}
        </span>
      </div>
      <div className="relative h-4 overflow-hidden rounded-[4px] border border-[var(--border-subtle)] bg-[var(--surface-control)]">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/4 border-l border-dashed border-[var(--border-subtle)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-2/4 border-l border-dashed border-[var(--border-subtle)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3/4 border-l border-dashed border-[var(--border-subtle)]"
        />
        {span.timed ? (
          <div
            className={cn(
              'absolute inset-y-0.5 rounded-[2px]',
              KIND_BAR_CLASS[span.kind]
            )}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              minWidth: '4px',
            }}
            title={`${span.label} · ${span.durationMs}ms`}
          />
        ) : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 border-t border-dashed border-[var(--border-subtle)]"
          />
        )}
      </div>
      <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
        {span.timed ? formatDurationMs(span.durationMs) : untimedLabel}
      </span>
    </div>
  );
}

function GanttChart({
  spans,
  untimedLabel,
}: {
  spans: ActivitySpan[];
  untimedLabel: string;
}) {
  const window = spanWindow(spans);
  const windowDuration = Math.max(window.endMs - window.startMs, 1);
  const hasTimed = spans.some((span) => span.timed);
  if (spans.length === 0) return null;

  return (
    <div className="space-y-1">
      {hasTimed ? (
        <div
          aria-hidden="true"
          className="grid grid-cols-[minmax(7rem,42%)_minmax(0,1fr)_3.75rem] items-center gap-2 px-1.5 pb-0.5 font-mono text-xs tabular-nums text-muted-foreground"
        >
          <span />
          <div className="flex items-center justify-between">
            <span>0ms</span>
            <span>{formatDurationMs(windowDuration / 2)}</span>
            <span>{formatDurationMs(windowDuration)}</span>
          </div>
          <span />
        </div>
      ) : null}
      {spans.map((span) => (
        <GanttRow
          key={span.id}
          span={span}
          windowStart={window.startMs}
          windowDuration={windowDuration}
          untimedLabel={untimedLabel}
        />
      ))}
    </div>
  );
}

export function SessionFlameGraph({ charts }: { charts: ActivityChart[] }) {
  const { t } = useTranslation('panels');
  const untimedLabel = t('workspaceActivity.untimed');

  return (
    <div className="space-y-3">
      {charts.map((chart, index) => {
        const hasTimed = chart.spans.some((span) => span.timed);
        const window = spanWindow(chart.spans);
        const totalMs = hasTimed
          ? Math.max(window.endMs - window.startMs, 1)
          : 0;

        return (
          <section
            key={chart.id}
            className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-none"
          >
            <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] pb-2">
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-[var(--surface-control)] px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums text-muted-foreground">
                  #{index + 1}
                </span>
                {chart.divider ? (
                  <p
                    className="min-w-0 flex-1 line-clamp-2 text-xs font-semibold leading-snug text-foreground"
                    title={chart.divider}
                  >
                    {chart.divider}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                {hasTimed ? (
                  <span className="rounded bg-[var(--surface-control)] px-1.5 py-0.5 text-foreground">
                    {formatDurationMs(totalMs)}
                  </span>
                ) : null}
                <span>
                  {t('workspaceActivity.stepsCount', {
                    count: chart.spans.length,
                  })}
                </span>
              </div>
            </div>
            <GanttChart spans={chart.spans} untimedLabel={untimedLabel} />
          </section>
        );
      })}
    </div>
  );
}
