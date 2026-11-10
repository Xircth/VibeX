import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ContextCardChunk {
  id?: string;
  title: string;
  chars: string;
  text: string;
  source: string;
  badge: string;
  tone: string;
  onOpenSource?: () => void;
}

export function ContextCardChunkIcon({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={cn('shrink-0 text-muted-foreground', className)}
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

export function ContextCardArrowIcon({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0 text-muted-foreground', className)}
      aria-hidden="true"
    >
      <path d="M7 17L17 7M7 7h10v10" />
    </svg>
  );
}

export interface ContextCardSourceMeta {
  badge: string;
  tone: string;
  sourceLabel: string;
  metricLabel: string;
}

export function formatByteMetric(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    const formatted =
      kb >= 10 || Number.isInteger(kb)
        ? String(Math.round(kb))
        : kb.toFixed(1).replace(/\.0$/, '');
    return `${formatted}KB`;
  }
  const mb = bytes / (1024 * 1024);
  const formatted =
    mb >= 10 || Number.isInteger(mb)
      ? String(Math.round(mb))
      : mb.toFixed(1).replace(/\.0$/, '');
  return `${formatted}MB`;
}

const SOURCE_BADGE_TONE = {
  text: 'bg-success/15 text-success',
  image: 'bg-warning/15 text-warning',
  pdf: 'bg-destructive/15 text-destructive',
  document: 'bg-info/15 text-info',
  file: 'bg-muted-foreground/15 text-muted-foreground',
} as const;

function estimateTextBytes(text?: string): number {
  if (!text) return 0;
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export function resolveContextCardSourceMeta(options: {
  itemKind: 'text' | 'image' | 'file' | string;
  fileName?: string;
  textContent?: string;
  byteSize?: number | null;
  fallbackSource?: string;
}): ContextCardSourceMeta {
  const rawName = (options.fileName ?? '').trim();
  const extMatch = /\.([a-z0-9]+)$/i.exec(rawName);
  const ext = extMatch ? extMatch[1].toUpperCase() : '';

  let badge = 'TXT';
  let tone: string = SOURCE_BADGE_TONE.text;

  if (options.itemKind === 'image') {
    badge = ext && ext.length <= 4 ? ext.slice(0, 3) : 'IMG';
    tone = SOURCE_BADGE_TONE.image;
  } else if (options.itemKind === 'file') {
    if (ext === 'PDF') {
      badge = 'PDF';
      tone = SOURCE_BADGE_TONE.pdf;
    } else if (ext) {
      badge = ext.slice(0, 3);
      tone = SOURCE_BADGE_TONE.document;
    } else {
      badge = 'FILE';
      tone = SOURCE_BADGE_TONE.file;
    }
  } else {
    if (ext === 'MD' || ext === 'MDX') {
      badge = 'MD';
      tone = SOURCE_BADGE_TONE.document;
    } else if (ext === 'JSON' || ext === 'YAML' || ext === 'YML') {
      badge = ext.slice(0, 3);
      tone = SOURCE_BADGE_TONE.document;
    } else {
      badge = 'TXT';
      tone = SOURCE_BADGE_TONE.text;
    }
  }

  const effectiveBytes =
    typeof options.byteSize === 'number' && options.byteSize > 0
      ? options.byteSize
      : estimateTextBytes(options.textContent);
  const metricLabel = formatByteMetric(effectiveBytes);

  return {
    badge,
    tone,
    sourceLabel: rawName || options.fallbackSource || '',
    metricLabel,
  };
}

export interface ContextCardSourcePillProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  badge: string;
  tone: string;
  source: string;
  interactive?: boolean;
}

export const ContextCardSourcePill = React.forwardRef<
  HTMLButtonElement,
  ContextCardSourcePillProps
>(function ContextCardSourcePill(
  { badge, tone, source, interactive = true, className, onClick, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        'collaboration-collection-source-pill inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium transition',
        !interactive && 'cursor-default',
        className
      )}
      {...props}
    >
      <span
        className={cn(
          'collaboration-collection-source-badge flex size-3.5 shrink-0 items-center justify-center rounded-none text-[7px] font-bold',
          tone
        )}
      >
        {badge}
      </span>
      <span className="truncate">{source}</span>
      {interactive ? <ContextCardArrowIcon /> : null}
    </button>
  );
});

export interface ContextCardsProps {
  chunks: ContextCardChunk[];
  className?: string;
}

export function ContextCards({
  chunks,
  className,
}: ContextCardsProps): React.ReactElement {
  return (
    <div className={cn('flex w-full flex-col gap-2.5', className)}>
      {chunks.map((chunk, index) => (
        <div
          key={chunk.id ?? `${chunk.title}-${index}`}
          style={{
            animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${index * 80}ms both`,
          }}
          className="collaboration-collection-card overflow-hidden"
        >
          <div className="collaboration-collection-card-header">
            <div className="collaboration-collection-creator min-w-0 flex-1">
              <ContextCardChunkIcon />
              <span className="truncate text-[13px] font-medium">
                {chunk.title}
              </span>
            </div>
            <div className="collaboration-collection-card-header-right">
              <span className="collaboration-collection-metric tabular-nums">
                {chunk.chars}
              </span>
            </div>
          </div>

          <div className="collaboration-collection-card-content">
            <p className="text-[13px] leading-relaxed">{chunk.text}</p>
          </div>

          <div className="collaboration-collection-card-footer">
            <ContextCardSourcePill
              badge={chunk.badge}
              tone={chunk.tone}
              source={chunk.source}
              interactive={Boolean(chunk.onOpenSource)}
              onClick={chunk.onOpenSource}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
