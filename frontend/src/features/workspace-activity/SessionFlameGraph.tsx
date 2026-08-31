import { cn } from '@/lib/utils';
import {
  spanWindow,
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

function SpanBar({
  span,
  windowStart,
  windowDuration,
  depth,
}: {
  span: ActivitySpan;
  windowStart: number;
  windowDuration: number;
  depth: number;
}) {
  const left = ((span.startMs - windowStart) / windowDuration) * 100;
  const width = Math.max((span.durationMs / windowDuration) * 100, 1.5);
  return (
    <div className="space-y-1" style={{ paddingLeft: depth * 12 }}>
      <div className="relative h-6 overflow-hidden rounded-sm bg-muted/40">
        <div
          className={cn('absolute inset-y-0 rounded-sm', KIND_CLASS[span.kind])}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={`${span.label} · ${span.durationMs}ms`}
        />
        <span className="relative z-10 truncate px-2 text-[11px] leading-6 text-foreground">
          {span.label}
        </span>
      </div>
      {span.children.map((child) => (
        <SpanBar
          key={child.id}
          span={child}
          windowStart={windowStart}
          windowDuration={windowDuration}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function SessionFlameGraph({ spans }: { spans: ActivitySpan[] }) {
  const window = spanWindow(spans);
  const windowDuration = window.endMs - window.startMs;
  return (
    <div className="space-y-2">
      {spans.map((span) => (
        <SpanBar
          key={span.id}
          span={span}
          windowStart={window.startMs}
          windowDuration={windowDuration}
          depth={0}
        />
      ))}
    </div>
  );
}
