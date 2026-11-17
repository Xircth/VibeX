import { useTranslation } from 'react-i18next';
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
  dotClass: string;
}> = [
  {
    mode: 'off',
    dotClass: 'bg-muted-foreground/60',
  },
  {
    mode: 'observe',
    dotClass: 'bg-warning',
  },
  {
    mode: 'auto',
    dotClass: 'bg-success',
  },
];

export function PulseEvalModeControl({
  value,
  onChange,
  disabled = false,
  lockAuto = false,
  size = 'md',
  ariaLabel,
  className,
}: PulseEvalModeControlProps) {
  const { t } = useTranslation('panels');
  const resolvedAriaLabel = ariaLabel ?? t('pulseFilter.evalModeAria');
  const isItemDisabled = (mode: PulseEvalMode) =>
    disabled || (mode === 'auto' && lockAuto) || !onChange;

  return (
    <div
      role="group"
      aria-label={resolvedAriaLabel}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-border bg-muted/65 p-0.5',
        className
      )}
    >
      {EVAL_MODES.map((item, index) => {
        const active = value === item.mode;
        const isLockedAuto = item.mode === 'auto' && lockAuto;
        const itemDisabled = isItemDisabled(item.mode);

        return (
          <button
            key={item.mode}
            type="button"
            tabIndex={active ? 0 : -1}
            aria-pressed={active}
            disabled={itemDisabled}
            title={isLockedAuto ? t('pulseFilter.lockAutoTitle') : undefined}
            onClick={(event) => {
              event.stopPropagation();
              if (itemDisabled) return;
              onChange?.(item.mode);
            }}
            onKeyDown={(event) => {
              if (
                disabled ||
                !onChange ||
                (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              for (let step = 1; step <= EVAL_MODES.length; step += 1) {
                const candidateIndex =
                  (index + delta * step + EVAL_MODES.length * 2) %
                  EVAL_MODES.length;
                const candidate = EVAL_MODES[candidateIndex];
                if (!isItemDisabled(candidate.mode)) {
                  onChange(candidate.mode);
                  const group = event.currentTarget.parentElement;
                  const buttons =
                    group?.querySelectorAll<HTMLButtonElement>('button');
                  buttons?.[candidateIndex]?.focus();
                  break;
                }
              }
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-5 px-2 text-2xs' : 'h-6 px-2.5 text-xs',
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
            <span>{t(`pulseDeck.modes.${item.mode}`)}</span>
            {isLockedAuto ? (
              <Lock aria-hidden="true" className="size-2.5 shrink-0" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
