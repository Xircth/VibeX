import { cn } from '@/lib/utils';
import {
  spanWindow,
  type ActivityChart,
  type ActivitySpan,
  type ActivitySpanKind,
} from './workspaceActivityModel';

const KIND_CLASS: Record<ActivitySpanKind, string> = {
  user: 'bg-primary/70',
  assistant: 'bg-[hsl(var(--success))]/70',
  tool: 'bg-[hsl(var(--warning))]/80',
  delegation: 'bg-primary',
  output: 'bg-muted-foreground/50',
};

function GanttRow({
  span,
  windowStart,
  windowDuration,
}: {
  span: ActivitySpan;
  windowStart: number;
  windowDuration: number;
}) {
  const left = span.timed
    ? ((span.startMs - windowStart) / windowDuration) * 100
    : 0;
  const width = span.timed
    ? Math.max((span.durationMs / windowDuration) * 100, 0)
    : 0;
  return (
    <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-2">
      <span
        className="truncate text-[11px] leading-4 text-foreground"
        title={span.label}
      >
        {span.label}
      </span>
      <div className="relative h-3 bg-muted/50">
        {span.timed ? (
          <div
            className={cn('absolute inset-y-0', KIND_CLASS[span.kind])}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              minWidth: '2px',
            }}
            title={`${span.label} · ${span.durationMs}ms`}
          />
        ) : null}
      </div>
    </div>
  );
}

function GanttChart({ spans }: { spans: ActivitySpan[] }) {
  const window = spanWindow(spans);
  const windowDuration = window.endMs - window.startMs;
  if (spans.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {spans.map((span) => (
        <GanttRow
          key={span.id}
          span={span}
          windowStart={window.startMs}
          windowDuration={windowDuration}
        />
      ))}
    </div>
  );
}

export function SessionFlameGraph({ charts }: { charts: ActivityChart[] }) {
  return (
    <div className="space-y-5">
      {charts.map((chart) => (
        <section key={chart.id}>
          {chart.divider ? (
            <p className="mb-2 border-b border-border pb-1 text-xs font-medium text-foreground">
              {chart.divider}
            </p>
          ) : null}
          <GanttChart spans={chart.spans} />
        </section>
      ))}
    </div>
  );
}
