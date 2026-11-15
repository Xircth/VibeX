import { Lock } from 'lucide-react';

import type { PulseEvalMode } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

export interface PulseEvalModeControlProps {
  value: PulseEvalMode;
  onChange?: (mode: PulseEvalMode) => void;
  disabled?: boolean;
  lockAuto?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

const EVAL_MODES: ReadonlyArray<{
  mode: PulseEvalMode;
  label: string;
  dotClass: string;
}> = [
  {
    mode: 'off',
    label: 'Off',
    dotClass: 'bg-muted-foreground/60',
  },
  {
    mode: 'observe',
    label: 'Observe',
    dotClass: 'bg-warning',
  },
  {
    mode: 'auto',
    label: 'Auto',
    dotClass: 'bg-success',
  },
];

export function PulseEvalModeControl({
  value,
  onChange,
  disabled = false,
  lockAuto = false,
  size = 'md',
  ariaLabel = 'Evaluation mode',
  className,
}: PulseEvalModeControlProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-border bg-muted/65 p-0.5',
        className
      )}
    >
      {EVAL_MODES.map((item) => {
        const active = value === item.mode;
        const isLockedAuto = item.mode === 'auto' && lockAuto;
        const itemDisabled = disabled || isLockedAuto || !onChange;

        return (
          <button
            key={item.mode}
            type="button"
            aria-pressed={active}
            disabled={itemDisabled}
            title={
              isLockedAuto
                ? 'Confirm external draft provenance before enabling Auto'
                : undefined
            }
            onClick={(event) => {
              event.stopPropagation();
              if (itemDisabled) return;
              onChange?.(item.mode);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm'
                ? 'h-5 px-2 text-2xs'
                : 'h-6 px-2.5 text-xs',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                active ? item.dotClass : 'bg-muted-foreground/35'
              )}
            />
            <span>{item.label}</span>
            {isLockedAuto ? (
              <Lock aria-hidden="true" className="size-2.5 shrink-0" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
