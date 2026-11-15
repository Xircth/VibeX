import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { AutomationTaskStatus } from './automationModels';

export function AutomationSplitFrame({
  master,
  detail,
  defaultMasterPercent = 45,
  testId,
  className,
}: {
  master: ReactNode;
  detail: ReactNode;
  defaultMasterPercent?: number;
  testId?: string;
  className?: string;
}) {
  const { t } = useTranslation('panels');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [masterPercent, setMasterPercent] = useState(defaultMasterPercent);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const raw = ((moveEvent.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.min(56, Math.max(36, Math.round(raw * 10) / 10));
        setMasterPercent(clamped);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    []
  );

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      style={
        {
          '--automation-master-width': `${masterPercent}%`,
        } as React.CSSProperties
      }
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-panel)] lg:flex-row',
        className
      )}
    >
      <div
        data-testid={testId ? `${testId}-master` : undefined}
        className="flex min-h-[240px] flex-col overflow-hidden border-b border-border bg-[var(--surface-panel)] lg:min-h-0 lg:w-[var(--automation-master-width)] lg:shrink-0 lg:border-r lg:border-b-0"
      >
        {master}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('pulseDeck.workbench.split.resizeAria')}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setMasterPercent((prev) => Math.max(36, prev - 2));
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setMasterPercent((prev) => Math.min(56, prev + 2));
          }
        }}
        className="hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/25 focus-visible:bg-primary/35 focus-visible:outline-none lg:block"
      />

      <div
        data-testid={testId ? `${testId}-detail` : undefined}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--surface-elevated)]"
      >
        {detail}
      </div>
    </div>
  );
}

const STATUS_STYLE_MAP: Record<
  AutomationTaskStatus,
  { dot: string; chip: string }
> = {
  running: {
    dot: 'bg-primary animate-pulse',
    chip: 'border-primary/35 bg-primary/10 text-primary',
  },
  testing: {
    dot: 'bg-warning animate-pulse',
    chip: 'border-warning/35 bg-warning/10 text-foreground',
  },
  publishing: {
    dot: 'bg-primary animate-pulse',
    chip: 'border-primary/35 bg-primary/10 text-primary',
  },
  published: {
    dot: 'bg-success',
    chip: 'border-success/35 bg-success/10 text-foreground',
  },
  pending_test: {
    dot: 'bg-warning',
    chip: 'border-warning/35 bg-warning/10 text-foreground',
  },
  editing: {
    dot: 'bg-muted-foreground/70',
    chip: 'border-border bg-[var(--surface-control)] text-muted-foreground',
  },
};

export function TaskStatusBadge({
  status,
  testId,
}: {
  status: AutomationTaskStatus;
  testId?: string;
}) {
  const { t } = useTranslation('panels');
  const style = STATUS_STYLE_MAP[status];
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium',
        style.chip
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {t(`pulseDeck.workbench.status.${status}`)}
    </span>
  );
}
